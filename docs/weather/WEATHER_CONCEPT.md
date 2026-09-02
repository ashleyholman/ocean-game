# Weather — concept, critique of the spec, and round plan

**Status: living implementation roadmap, updated 2026-08-18.** WX1 and WX2 are
complete. The 2026-08-17 weather MVP also implements authored clear/rain/storm
conditions, weather-driven cloud cover and visibility, deterministic near rain,
seeded lightning with distance-delayed thunder, and an optional in-world wind
vector. The 2026-08-18 WX3 slices add one shared spatial cat's-paw field and
moving cloud-cast sunlight on the near/mid ocean without changing wave motion.
Their visual/aural verdict remains open; see the weather MVP and the two
`docs/weather/WX3_*_HANDOVER_2026-08-18.md` handovers.

The document began as a negotiation record on 2026-08-16. Sections 1–5 retain
that historical critique and baseline rather than pretending they were written
after the implementation.

The spec under review is `docs/archived/upcoming-prompts/weather-prompt.txt` — 2288
lines, 73 KB, 80 numbered acceptance criteria, 60 validation cases and a
37-step implementation sequence, all addressed to a single implementation
session.

Baseline: `master` 63308dc. `npm test` — **1169 passed, 26 skipped, 93 of 94
files, 68 s**; `npm run test:full` is 1195 in 94. Everything below was read
from source where source exists. **A great many of this repository's own
documents are stale on exactly the subjects a weather round touches**, and
§2.7 lists them; where a document and the code disagree, the code is quoted.

---

## 1. What weather is for

The sea is the antagonist and the player is a captain. Weather is how the
antagonist announces itself before it arrives, and how a day acquires a shape
the player did not choose.

Three jobs, in order of how much they matter here:

1. **It makes the sea's condition legible as something that came from
   somewhere.** Today the sea is a preset picked from a debug panel.
   `CURRENT_MODERATE` is not weather; it is a setting. The moment the wind
   freshens because a front is passing, and the sea builds *behind* the wind
   rather than with it, the sea stops being scenery and becomes a consequence.
   `docs/project/FUTURE_ROUNDS.md:70-75` already says this is the job: "sea
   states that evolve with the voyage rather than being selected … a weather
   system only has to decide the parameters."

2. **It gives the captain something to read, and therefore something to
   decide.** A 1790s captain has three instruments for the future: the glass,
   the sky, and the feel of the swell. `docs/ship/CAPTAINS_QUARTERS_HANDOVER.md:104-116`
   records the debt exactly — Ash's condition was that an instrument must
   actually work, there is no atmospheric pressure anywhere in the world model,
   and the barometer was cut because "a barometer's entire job is to *lead* the
   weather by hours and there is no weather that changes over hours for it to
   lead". That handover hands the fix to this round by name: "a slow pressure
   series driving mean wind and sea state, on the same
   deterministic-function-of-time pattern `WorldWind` already uses. After that
   the barometer is an afternoon's work."

3. **It makes the same water look different.** Third, not first. It is also
   the only one the spec under review is about.

That ordering is the whole disagreement with the spec, and everything in §3
follows from it.

---

## 2. How much of weather already exists

More than the spec assumes, and in a different shape. This is the most useful
output of the round: **most of the forcing is built, none of the state is.**

### 2.1 There is already exactly one wind authority — and it is the sea state

The spec's central architectural complaint is that the project has two mutable
values both labelled "current wind speed" and lets consumers pick arbitrarily
(`weather-prompt.txt:671-687`). **That is not what is wrong here.** The chain
is single and traceable:

| step | file:line | what |
|---|---|---|
| origin | `src/ocean/presets.ts` — 11 presets, e.g. `CURRENT_MODERATE` at `:240-247` | each carries `wind { speedMps, directionDeg, gustiness, maturity }` |
| interpolation | `src/ocean/SeaStateController.ts:101-111`, `src/ocean/seaState.ts:354-391` | smoothstep-eased lerp of every field; headings by shortest arc (`:322-325`) |
| physics authority | `src/runtime/VesselRuntime.ts:419` | `worldWind.setMean(seaWind.speedMps, seaWind.directionDeg, seaWind.gustiness)` — **every frame, unconditionally** |
| presentation authority | `src/runtime/VesselRuntime.ts:425` → `src/scene/WindSystem.ts:89-93` | "The sea state is the authority for what the wind is doing; this class only presents it." |

So `WorldWind.meanSpeedMps ≡ seaState.wind.speedMps`, identically, every frame.
`WorldWind` owns *only* the gust deviation on top, and it **has no other
setter**. There is no orphaned second wind and no lag.

What there is instead is a **naming collapse**: one number is simultaneously
(a) the wind now and (b) the wind that grew this sea. Because they are the same
number, there is no way to express *the wind has freshened and the sea has not
built yet* — the most characteristic thing weather does to water. The
consequence is concrete: **changing the wind today requires replacing the sea
state.**

The spec's diagnosis of the mechanism is therefore wrong; its identification of
the missing concept (`:615-670`, present atmospheric wind vs wind-sea memory)
is exactly right. Its prescribed migration is the wrong shape (§3.3a).

**Three genuine duplications do exist**, and they are the real seam list:

- **Shader uniform defaults are a second wind.** `src/scene/FoamField.ts:830-831`
  `uWindDir = (1,0)`, `uWindSpeed = 6`; `src/scene/Ocean.ts:3608-3609`
  `uWindDir = (1,0)`, `uWindStrength = 6.0`.
- **`WindSystem`'s constructed state is a third.** `src/scene/WindSystem.ts:16,18`
  — `headingDeg = 68`, `strength = 6.0`, live until the first `setOceanWind`.
  The heading does not match `CURRENT_MODERATE`'s 144°.
- **Four consumers bypass both objects and read `seaState.wind` directly**:
  `src/scene/Waves.ts:534` (breaking threshold) and `:569` (Cox–Munk slope),
  `src/runtime/ProductionSimulationRuntime.ts:219` (ambient whitecap coverage),
  `src/runtime/WakePresentationController.ts:279,334`, and — a genuine
  divergence-in-waiting — `src/runtime/diagnostics/createSimHandle.ts:137`
  passes foam `sea.wind.speedMps` where production
  (`ProductionSimulationRuntime.ts:230`) passes `worldWind.meanSpeedMps`.
  Identical today only because `setMean` copies verbatim.

**All three of these are closed by WX2**, and the line-by-line verdict on every
reader is in that round's section below: the shader defaults are zeroed, the
`WindSystem` constructed wind is zeroed, two of the four direct readers are
re-pointed and two are knowingly left with their reasons, and the
`createSimHandle` divergence is fixed with a test that would have caught it.
The field the whole list refers to is called `generatingWind` from that round
on, and it no longer means "the wind".

### 2.2 The temporal gust process is built, tested, and deliberately off screen

`src/world/WorldWind.ts` is complete and pinned:

- `WORLD_WIND_DEFAULT_SEED = 0x57696e64` (`:50`), shared by production and
  evidence deliberately.
- `SPEED_GUST_AMPLITUDE_FRACTION = 0.4` (`:53`), `DIRECTION_WANDER_DEG = 8`
  (`:56`).
- A **seeded sum of incommensurate sinusoids**, amplitude-normalised so
  `|value| ≤ 1` (`:110`): speed on 6 components over **8–70 s**, direction on 4
  over **40–240 s** (`:126-131`). A pure function of elapsed wind time — no
  integration, no `Math.random()`, exactly caller-rate invariant.
- Advanced on presentation seconds (`src/runtime/VesselRuntime.ts:424`); its
  header says "ordinary physics seconds — never voyage time" (`:176`).
- Conventions pinned by `tests/world-wind.test.ts` (:42-238, including
  512×(1/64) vs 128×(1/16) **exact** equality at `:154-167` and zero-gustiness
  reproducing the mean with `toBe` at `:181-190`), with committed evidence at
  `evidence/world-wind/gust-baseline.json` and physical gates in
  `src/world/WorldWindEvidence.ts:172-258` (≤3% ten-minute mean drift; gust
  zero-crossing interval in 3–60 s).

And its own header says the thing that matters most (`:7-10`):

> "Presentation systems keep reading the mean this round … Feeding gusts into
> foam, spray or cloth is a deliberate future look change, not a side effect of
> this file."

Confirmed at the call sites: foam and crest spray get `meanSpeedMps`
(`ProductionSimulationRuntime.ts:230,251`). The only consumers of
`instantaneousSpeedMps` are the sail forces
(`src/vessel/schooner/SchoonerSailForces.ts:125-131`, on its own 240 Hz substep
clock) and the wind cues (`src/vessel/Vessel.ts:52-62` — "an indicator that
ignores gusts is an indicator that is wrong most of the time").

### 2.3 The foam-local prototype has become the shared spatial field

Before WX3, `FoamField` alone carried this GPU-only prototype:

```glsl
float g = vnoise(p * 0.010 + uWindDir * uNoiseTime * 0.06);
gust = mix(1.0, 0.25 + 1.9 * g, uGustiness);
```

`p` is the foam parameter-space position. It made plausible ~100 m breaking
patches but had no CPU mirror, no physical amplitude or scale controls, and no
reader outside foam.

The 2026-08-18 WX3 first-half checkpoint replaced that positive-amplitude path
with `src/weather/CatsPawField.ts`: one seeded, band-limited CPU/GLSL source in
wrapped canonical ECEF coordinates. Foam retains the exact block above only as
the literal zero-amplitude compatibility arm, so Ash can compare against the
pre-WX3 pixels. The anisotropic windrow texture remains a foam-grain treatment,
not a second wind-strength authority.

### 2.4 The cloud system is a marched 3D volume — one deck, 192 steps

The spec asserts the starting point is "one thin, flat, uniformly parameterised
cloud layer" (`:830`). That is wrong in the direction that matters: it is a
genuine volume. It is also wrong about the *number* of decks in the other
direction, because the repository's own roadmap is stale.

What is actually there (`src/scene/shaders/lib.ts`, `src/scene/CloudDome.ts`):

- `cumulusDeck()` (`lib.ts:1291-1480`) — a true slab traverse from
  `CLOUD_BASE = 1100` to `CLOUD_TOP = 3300` m (`lib.ts:839-842`), each sample at
  its own world position and height; step `dt = min(seg/CLOUD_MARCH,
  CLOUD_STEP_MAX)` with `CLOUD_STEP_MAX = 150` m; reach `CLOUD_REACH = 17000` m.
- **`CLOUD_MARCH = 192`** on desktop *and* mobile (`src/scene/Ocean.ts:363,393,414`),
  raised from 96 because "the low sky … was banding there at 96 and still
  improving at 192" (`Ocean.ts:344-362`). Sun march 5 steps desktop / 3 mobile,
  geometric.
- Weather map: `cloudCoverAt()` (`lib.ts:1057-1061`), `uCloudCover = 0.70` —
  **a mean threshold, not a coverage fraction** (`src/scene/SkySystem.ts:392`).
  Regional threshold modulation gives streets, lanes and holes.
- A sparse direction cache: logical map **6144×1280** desktop / 4096×768 mobile
  over −3.44°…90° elevation, tiles **256×128**, a pool of 120 slots, a
  synchronised generation every `CLOUD_TILE_REFRESH_FRAMES = 60` rendered
  frames, with sample-time advection between bakes clamped to 400 m
  (`CloudDome.ts:30-45`, `src/scene/cloudTileScheduler.ts:10`, `lib.ts:192-215`).
- The bake is **factored**: `cloudBake()` emits three multiple-scattering
  accumulators plus two ambient weights and opacity; `cloudLayerCached()`
  relights per frame with this frame's sun and moon (`lib.ts:1561,1642-1655`).
- The whole field is mirrored on the CPU in `TimeOfDay.ts` and **the mirror is
  enforced by `tests/shader-source.test.ts`**. Any new cloud constant must go in
  both files and into that test, or the scene is lit by clouds that are not on
  screen.

**`lib.ts:834-837` already states the weather hook**: the altitude constants
are meant to be promoted to uniforms and "that is the only edit the light
transport below would need."

**The cirrus deck was deleted** (commit `35d866f`, 2026-07-31); no `CIRRUS_*`
constant survives. `docs/clouds/CLOUDS_ROADMAP.md:151` marking item 3 "DONE" is
false. There is one deck. A high deck for weather is a build, not a re-use —
though `CLOUD_STRUCTURE_HANDOVER.md:86-114` plus the three corrections in
`CLOUD_MOTION_REPORT.md:126-155` are a complete, already-paid-for recipe, and
the reason it was deleted was look ("smeared pale bands rather than fibres"),
not cost.

### 2.5 Wind aloft, and cloud → light coupling

`src/scene/SkySystem.ts:62-105` derives cloud-level flow from the surface wind
rather than authoring it: `CUMULUS_WIND_VEER_DEG = 22`, `CUMULUS_WIND_GAIN =
1.85`, `CUMULUS_EVOLVE_RATIO = 1/14` (~25-minute cumulus lifetime). The
**sense** of the veer reads the observer's latitude — clockwise from above in
the north, anticlockwise in the south, ramping to nothing across five degrees of
the equator (`:69-77,91-93`). The spec's "simple per-layer speed and direction
offsets" (`:930-935`) is a worse answer than the one in the file.

| the spec asks for | already in the code |
|---|---|
| criterion 27, dense cloud attenuates stars | **Done.** Per-star occlusion through the cloud cache, `src/scene/StarField.ts:218-313`; written up in `docs/graphics/NIGHT_SKY_ROUND_REPORT.md:122-140`. |
| criterion 28, cloud transmittance gates matching celestial light | **Done.** Sun via a **16-point solar-disc quadrature** amortised 4 points/frame, averaging transmittance not optical depth (`src/scene/TimeOfDay.ts:225-253,1444-1497`); moon by single ray (`:883`); ambient fill is a 9-direction hemisphere mean of `skyWithClouds()` (`:914-931`); the SH/PMREM probe composites a 32×16 CPU cloud gate (`src/scene/WorldRadianceSource.ts:59-70`). |
| a "how much cloud lies this way" query | **Done.** `TimeOfDay.cumulusTransmittanceToward()` (`:1505-1559`), a CPU mirror of the same volume at 14 march steps. |
| criterion 29, broad moving cloud shadows over ocean and vessel | **Ocean implemented; vessel remains global.** `sunPoolCloudTransmittance` in Ocean's fragment shader replaces the scalar locally with one density sample halfway along the bounded cloud-slab ray. It rides both `uCloudOffset` and `uCloudEvolve`, gates every established direct-ocean-sun consumer together, and returns exactly to `uSunCloudTrans` for neutral/zero and beyond 3.2 km. Hull/deck directional lighting still receives the observer's scalar. See `WX3_SUN_POOLS_HANDOVER_2026-08-18.md`. |
| criterion 31, visible and reflected cloud agree | **Deliberately not, and for a recorded reason.** The water's mirror is `skyRadiance(R)` — gas sky only; drawn cloud on wavy water read as oil-slick rings (`GRAPHICS_TODO.md:12-24`). Cloud enters reflection only as the hemispheric mean. The parked fix is a prefiltered sky+cloud environment cubemap (`GRAPHICS_TODO.md:74-85`), which is also what the spec independently proposes at `:989-995`. |

### 2.6 The rest of the inventory

- **Sea-state transitions.** `SeaStateController.set(next, seconds)`
  (`src/ocean/SeaStateController.ts:76-91`) already redirects from the current
  interpolated state mid-transition rather than jumping back, eases by
  smoothstep, and snaps at `seconds <= 0`. `WaveField.applySeaState(state,
  continuous)` (`src/scene/Waves.ts:415,610-632`) carries each slot's phase
  across the change and re-slaves bound harmonics algebraically. **The spec's
  `WeatherController` is a second instance of a pattern this codebase already
  ships and tests.**
- **Visibility already has a control.** `hazeDistanceM = 9000` m
  (`src/scene/oceanOptics.ts:122`), consumed as `exp(-dist/uHazeDistance)`
  against the gas-sky radiance (`Ocean.ts:3270-3290`), with the same form on
  terrain (`src/terrain/TerrainSystem.ts:189-198`). (`FUTURE_ROUNDS.md:56` still
  says 2600 m; stale.)
- **Whitecap coverage** is Monahan: `W = 3.84e-6 · U^3.41` soft-maxed to a
  0.105 ceiling (`src/ocean/spectrum.ts:738-757`). Note also
  `WIND_VALIDITY_CEILING = 32` and `effectiveGrowthWind()` (`:706-722`) — wave
  *growth* saturates above 24 m/s while whitecaps, streaks, spray and foam take
  the raw value. A weather round that pushes wind past 24 m/s must know this.
- **A wetness idiom exists; a wetness system does not.** `src/scene/HullWetBand.ts`
  is a waterline band: a mask × `uWetHullDarkening` on albedo (`:291`) ×
  `uWetHullRoughnessScale` on roughness (`:295`). Exactly the right shape for
  rain, and scoped to the hull. The spec's "the final material/wetness
  architecture established by the graphics round" (`:1137`) does not exist.
- **Precipitation: zero.** Grepped. The only "rain" in `src/` is two comments in
  `src/scene/Lamp.ts:16,204` about the lantern's cap shedding it.
- **Audio: 130 lines, and not a wind consumer.** `src/audio/Ambience.ts` is
  three noise-shaped Web Audio nodes, muted by default, with
  `update(dt, sail)` — the rigging gain is `0.045 + 0.055·sail`, a raft-era
  binary sail scalar. **Wind speed and direction reach the audio system
  nowhere.** No listener, no positional audio. The spec's "follow the
  established camera/listener architecture" (`:1253`) refers to nothing.
- **Shadows: one 2048² map containing the vessel and nothing else**
  (`src/main.ts:509-547`), ±14 m lateral, 13.7 mm texels, ocean explicitly
  non-casting (`Ocean.ts:3802`), no moon shadow. Penumbra is variable but
  clamped at 14 texels (~19 cm) where a 2° sun wants ~2 m
  (`docs/graphics/SHADOW_ROUND_HANDOVER.md:184-207,289`).
- **Exposure sees clouds but not lamps.** `EXPOSURE_MIN/MAX = 0.42/5.2`
  (`TimeOfDay.ts:127-128`); the meter reads 8 horizon directions through
  `skyWithClouds()` plus the ambient fill (`:1047-1057`), so an overcast **does**
  move exposure — but `docs/ship/CAPTAINS_DESK_HANDOVER.md:66-71` measures the
  meter at 0.0815 with the lantern lit at night against 0.109 at noon unlit.
  **A squall going dark will open the meter and brighten the lantern.** That is
  a weather consequence nobody has looked at.
- **Closures.** `src/vessel/schooner/closures.ts:37` — `hatchwayBoards` and
  `foreScuttleLid`, a state table read by four systems, five light channels
  below. Rain on an open hatch is a weather consequence the spec never
  considers, because the spec thinks the vessel is a raft.
- **A latent bug a long weather session will hit.** Cloud drift wraps at
  `DRIFT_WRAP_M = 4_000_000` m — about 7 hours of play — and it is a
  **discontinuity, not a wrap**: the whole sky changes in one frame
  (`src/scene/SkySystem.ts:106-124`).

### 2.7 Documents that are stale on exactly this subject

Reported under house rule 8. An implementer who reads the docs instead of the
code will get all of these wrong, and one of them is almost certainly where the
spec's "72×" came from.

| document | claim | reality |
|---|---|---|
| `docs/world/WORLD_MODEL.md:222-226` | default scale **72×**, 1200 real s per world day | `src/world/clock.ts:11-17` — **30×**, 2880 real s. **Corrected by WX1.** |
| `docs/world/WORLD_MODEL.md:244` | "There is no third voyage clock." | `src/world/voyageClock.ts` is the third clock. **Corrected by WX1**, which also names the fourth. |
| `docs/clouds/CLOUDS_ROADMAP.md:151` | cirrus deck "DONE" | deleted, commit `35d866f`. **Corrected by WX1** — but this file is contended; see the WX1 note. |
| `docs/clouds/CLOUD_MOTION_REPORT.md:45-70`, `GRAPHICS_TODO.md:65-70` | `CLOUD_TIME_RATE` 0.2 × world; 160 m/real s | `CLOUD_WALL_RATE = 1.0`, `SkySystem.ts:59` |
| `docs/clouds/CLOUD_SHAPE_FINDINGS.md` FACT 1/2 | density ∝ 2D coverage; flat-slab projection | superseded by the 3D field and true traverse, `35a3f9b`. **The Worley *verdict* still stands; the algebra does not.** |
| `docs/graphics/GRAPHICS_TODO.md:27-33` | "Stars shine through overcast" | fixed in the night-sky round |
| `docs/graphics/GRAPHICS_TODO.md:205-208` | `CLOUD_MARCH_DITHER` | retired entirely; steps raised 96→192 instead |
| `docs/graphics/COLOUR_PIPELINE_HANDOVER.md:74-93` | `pow(sunMag,0.52)*8`; single-ray sun occlusion | linear `SUN_IRRADIANCE_SCALE = 9.0`; 16-point disc |
| `docs/graphics/GRAPHICS_TODO.md:433-436` | daylight exposure plateau 0.335 | gone; one adaptation curve all day |
| `docs/project/FUTURE_ROUNDS.md:39,51,56` | schooner "not started"; graphics "next round"; `uHazeDistance` 2600 m | schooner largely built; graphics rounds done; 9000 m. **The haze figure corrected by WX1**; the other two belong to the round already editing this file. |
| `docs/sailing/SAILING_MODEL_DESIGN.md:290` | crew evolutions divide by "the voyage compression" | code divides by the **calendar** constant, as `src/world/clock.ts:29-31` requires. Harmless while both were 30×; live since voyage went to 1×. **Corrected by WX1.** |
| `docs/project/TESTING.md:62-73` | 663 tests | 1195 |

---

## 3. Critique of `weather-prompt.txt`

### 3.1 What it gets right

1. **The A/B/C split** — present atmospheric wind, developed wind-sea memory,
   remote swell as three independent quantities (`:615-670`). Correct physics
   and the single most valuable idea in the document. §2.1 shows the codebase
   collapses A into B.
2. **"Do not use gusts to multiply the large Gerstner displacement field"**
   (`:813-823`). Exactly right, and it protects a verified buoyancy contract.
3. **Rain impacts registered to the water's parameter space, not slid over
   displaced waves** (`:1120-1124`). The persistent foam field is already
   indexed in Gerstner parameter space for that reason.
4. **The extension-point discipline** — no second travel accumulator, no
   parallel planar voyage position, no weather coordinates on camera yaw
   (`:604-613`). Matches `docs/adr/ADR-002-planetary-world-model.md` and
   `FUTURE_ROUNDS.md:89-94`. Adopt verbatim.
5. **Weather presets must not silently overwrite sea state, camera, world
   position or time** (`:1359-1381`) — as a *diagnostic* requirement. §3.3c on
   why the default must be inverted.
6. **"Do not add inert fields merely to make the interface appear
   meteorological"** (`:470-472`) — sound principle, exactly one wrong
   application.

### 3.2 What is stale — the spec was written against a raft

Its baseline is `9d796db`, "Float the raft", and it never left. It says raft or
castaway throughout: raft-centred renderer, raft buoyancy, the raft lamp,
"restrained rain wetness on the raft and castaway materials" (`:1135-1152`),
"the seated castaway's eyes".

The vessel is a **15.5 m two-masted topsail schooner** with a walkable cambered
deck, six trimmable sails, a companionway, a fore scuttle, a hold, a captain's
cabin with a berth, lockers, a chart desk and a chronometer, five interior
light channels, and a crew that holds a course. Consequences:

- "Rain wetness on exposed materials" is a deck, a rig, cloth, cordage, and an
  **interior that water can get into through two closures**. That is a larger
  and more interesting problem than the spec's one paragraph, and it is the one
  place weather touches something the player can act on.
- `docs/ship/CAPTAINS_QUARTERS_HANDOVER.md:127-130` already names **deadlights**
  — shutters over the cabin glass in heavy weather — as owed debt, with "the
  closure table already has the machinery". Heavy weather is why deadlights
  exist. The spec cannot see this.
- Its audio scope assumes an ambience architecture (§2.6).

And the numeric flag: **"the accelerated 72× … world-time delta"** (`:581`).
There is no 72×. It is very likely inherited from `WORLD_MODEL.md:222-226`,
which still says so (§2.7).

### 3.3 What contradicts systems that already exist

**(a) The migration direction inverts an authority chain pinned by five rounds
of tests and six committed baselines.**

The spec: weather owns present wind; `SeaState.wind` becomes
"generating/effective wind"; "the final presentation `WindSystem` … should not
remain an independent wind authority" (`:676-687`).

The code chose the opposite deliberately —
`docs/sailing/SAILING_MODEL_DESIGN.md:137-152`: "The sea state is already the
authority … Layer 1 promotes this to a queryable world wind **rather than
inventing a second weather source**." Everything downstream was then gated on
it: S1's convention tests, S2's polar, S3's turn/tack/helm, S5's crew, and
`evidence/world-wind/gust-baseline.json`. Design invariant 5
(`SAILING_MODEL_DESIGN.md:131-136`) makes those non-negotiable, and house rule 6
records that the project has burned a full round on each of two sign
conventions already.

Reaching *around* the sea state to insert weather between it and its readers
regenerates every one of those baselines and re-opens both conventions. The fix
is not to argue with the physics — the physics is right — but to put weather
somewhere else: **upstream of the sea state, not between it and its readers**
(§4).

**(b) The prohibition on pressure contradicts a standing, Ash-conditioned
request.**

`:470-472` forbids pressure fields. `CAPTAINS_QUARTERS_HANDOVER.md:104-116`
says the barometer was cut *for want of one* and hands the fix to this round.
The spec's principle is sound and its application is backwards: pressure here
is not decoration, it is the **only** field with a waiting consumer that also
does the thing weather is for — it leads. It is a scalar function of time and
position; it costs nothing; and it is the natural generator for mean wind and
cloud state so that those agree with each other by construction rather than by
preset authorship. **Refuse this prohibition.**

**(c) "Weather presets must not silently select a sea state" is right for the
lab and wrong for the game.**

`:1359-1381` forbids the coupling; `FUTURE_ROUNDS.md:70-75` says the coupling
*is the feature*. Both can hold, with the default inverted: **coupled in play,
decoupled behind an explicit `Independent` diagnostic mode**, so the mismatched
combinations the spec lists stay constructible in the lab without making the
game a scene-setting panel.

**(d) The cloud brief argues for techniques the project has already passed, and
misses the hook its own roadmap names.**

`:868-876` offers "layered analytic shells; depth-aware impostors; limited
ray-marched volumes; hybrid geometry" against a 192-step marched volume with a
factored sparse cache (§2.4). Meanwhile it never mentions
`docs/clouds/CLOUD_STRUCTURE_HANDOVER.md:70-83` — a **type channel on the
weather map** with per-type height gradients (stratus / cumulus /
cumulonimbus): "it is exactly the hook the weather round wants — a weather state
maps to (coverage, type, precipitation) per region and everything else follows.
**Do this first.**"

**(e) Determinism.** House rule 5 bans `Math.random()` in anything evidence
touches; `src/audio/Ambience.ts`'s noise buffer already uses it. Weather audio
work inherits that and should fix it rather than extend it.

### 3.4 What is unbuildable, or not gateable, at this project's budget

**(f) Criterion 24 requires fixing a defect whose fix was already rejected on
look.** "No obvious cloud tile, dome seam, **bald horizon band** or scale jump
remains."

`docs/clouds/HORIZON_CLOUD_BAND_REPORT.md` — "Diagnosed, fixed, benchmarked,
and **rejected on look**", parked on tag
`rejected/horizon-cloud-band-2026-08-03`, nothing merged. Three multiplicative
causes, all still in the code (`:177-183`):

- `cloudRes`, a Nyquist fade, drives the deck to a **hard zero below ~3.2°**
  (`lib.ts:1294-1295`) — the binding cause;
- the uniform-slab haze `exp(-t·0.000042)` removes **~41% of a cloud's radiance
  at 10°** where the honest boundary-layer figure is ~16% (`lib.ts:1477`);
- the `max(dir.y, 0.016)` clamp pins everything below **0.92°** to one distance
  and will extrude the deck into pale vertical curtains the moment anything
  draws there (`lib.ts:1312`).

The rejection was structural, not tuning (`:95-119`): a mean-field substitution
saturates alpha to near-binary and lights opaque cloud as if it were thin.
"A statistical mean cannot look like the same clouds continuing. If this is ever
retried, it has to keep marching the *real* field further down — more cache rows
near the horizon, a supersampled bake in those rows, or TAA." The measured cost
of the rejected build was **+9.8% GPU frame** (20.62 → 22.65 ms).

**Do not make this a weather gate.** It is also load-bearing *for* weather: an
overcast ceiling and a distant rain curtain are horizon objects, so weather will
*expose* this more than clear sky does. That is a risk to state, not a criterion
to sign.

**(g) The performance targets cannot be honestly measured by the methods the
spec assumes, and the baseline is already regressed.**

Measured (`evidence/performance/2026-08-09-summary.json`,
`docs/project/PERFORMANCE_REGRESSION_REPORT.md`), M2, headless Chrome/Metal,
2560×1440 backing store: the central day case is **17.006 ms** (~58.8 GPU-fenced
FPS), up from 14.013 ms at `38440b5` — **+2.994 ms, +21.4%, unclosed**;
reproduced next day at +2.856 ms / 19.5% under strictly-nominal thermal. Rough
is **21.900 ms**. Ocean attributes **9.254 ms**. The cloud bake is the other large term:
`src/scene/Ocean.ts:344-363` records it as **~8.2 ms at 192 steps against ~5.9
at 96**, affordable only because it is amortised over sixty frames at roughly
one tile each — so a weather round that raises coverage or deepens the slab is
spending against a term that is already the frame's second biggest and has no
headroom in its schedule. The largest confirmed
cliff is `ee69193`, +1.178 ms of ocean-look shader work, never A/B'd internally.
And **`perf-results/` stops at `f3d542c`; everything since — quarters, desk,
furniture, interior lanterns, S5 crew — is unmeasured against it.**

The only honest channel is the CDP harness under `tools/perf/`
(`--headless=new --enable-gpu --use-angle=metal`, 1280×720 CSS at DPR 2,
`readPixels` fence with `PIXEL_PACK_BUFFER` unbound, alternating rounds,
`--require-nominal-thermal`). `gl.finish()` does not synchronise in the agent
browser (`CLOUDS_ROADMAP.md:193-198`: a cloudless dome at 18 ms and a cloudy one
at 0.07 ms in the same run), and a **visible window costs about 3×**. Thermals
move the same revision 14.05 → 20.31 ms in one sweep.

The standing mandate outranks the spec anyway (`CLOUDS_ROADMAP.md:7-23`): "Make
it beautiful. Then Ash decides what to keep. Performance is a separate, later
round."

**(h) The round is not a round.** 80 acceptance criteria, 60 validation cases in
stills *and* motion, a 37-step sequence, three subagents and a three-pass critic
loop, delivering a canonical state model, a wind-authority migration, a spatial
gust field, four cloud archetypes, a visibility model, two-scale precipitation,
rain–ocean interaction, a material wetness system, six audio layers, lightning,
thunder, a developer lab and quality tiers. Against a house style whose rounds
are one checkpoint with one accept-when sentence, that is **six to eight
rounds**, and committing to it as one produces the failure the spec itself warns
about at `:1917`.

### 3.5 What it silently assumes

- That a **material/wetness architecture** exists (§2.6: a hull waterline band).
- That a **camera/listener audio architecture** exists (§2.6: 130 lines, muted,
  and not even a wind consumer).
- That clouds are **flat** (§2.4) — and, symmetrically, that a **cirrus deck**
  is available to re-use (it was deleted).
- That wind authority is **duplicated** (§2.1: singular and misnamed; the real
  duplications are elsewhere).
- That the vessel is a **raft with a lamp** (§3.2).
- That the world runs at **72×** (§2.7: calendar 30×, voyage 1×, weather 1×).
- That **the implementer can certify the visual result.** House rule 7:
  "'Pixel-identical' is the only self-certifiable visual claim." Roughly half of
  the 80 criteria are look judgements. They are Ash's.
- That **GPU cost is measurable in the ordinary loop** (§3.4g).
- That a **preset-driven provider is a satisfying endpoint.** It is the spec's
  explicit terminus (`:100-112`, and the OUT OF SCOPE list at `:1839-1895`
  deletes evolution, scheduling and geography). It is also exactly where the
  game already is, with the sea-state panel. A round that ends there has added
  six presets to a game that had eleven.

### 3.6 What I would refuse

1. **Refuse the round as one round.** Split as §6.
2. **Refuse the prohibition on pressure** (§3.3b). Build the series; it is the
   cheapest field in the system and the only one with a waiting instrument.
3. **Refuse criterion 24's "bald horizon band"** as a weather gate (§3.4f).
   Carry it as a stated risk and a cloud-round dependency.
4. **Refuse the wind migration as specified** (§3.3a). Take the physics, invert
   the plumbing.
5. **Refuse weather–sea independence as the default** (§3.3c).
6. **Refuse the performance acceptance targets** (§3.4g) — including "stable
   ~30 FPS on a modern 4K desktop" and the mobile tiers — as gates on this
   work. The mandate defers them; the instrumentation to take them honestly is
   partly missing; and the baseline they'd be measured against is 6 days and
   several rounds stale.
7. **Refuse the 60-case × stills-and-motion matrix** as a gate. This project's
   idiom is a small deliberate contact sheet plus `npm run inspect:view` for
   deterministic single shots. Each round below names its own.
8. **Refuse the audio scope.** Six weather layers, distance-filtered thunder and
   "restrained spatial presentation" on top of a muted 130-line ambience that
   does not read wind is a sound round, not a weather deliverable. WX5 takes
   rain as a single gain on an existing node; the rest waits.
9. **Refuse "rain wetness on the raft and castaway materials"** as the scope
   statement (§3.2). The interesting version is a smaller *material* change and
   a larger *consequence*.
10. **Refuse the spec's factual claims about the starting point** — flat clouds,
    duplicated wind, 72×, an existing wetness or listener architecture. An
    implementer who takes them on faith will spend the round rebuilding things
    that work.

---

## 4. The negotiated design

Four layers, each naming one owner of truth and its readers. Nothing forks an
existing system; the one new authority sits **above** the sea state, where
`FUTURE_ROUNDS.md` always said it would.

```
        (future) provider: f(ECEF, UTC) ──┐
                                          ▼
  L0  WeatherState        ── the one weather truth, upstream of everything
        │  pressure, wind, sky, precipitation, visibility, activity
        ├──────────────► SeaStateController      (wind-sea target, slow)
        ├──────────────► WorldWind.setMean()     (present wind, immediate)
        ├──────────────► SkySystem cloud state   (cover, type, ceiling)
        └──────────────► the glass and the sky   (captain's instruments)

  L1  Present forcing     ── WorldWind owns it; interface unchanged
        temporal gusts (built, §2.2) + spatial field (half-built, §2.3)
        readers: sails, foam, spray, cloth, glint, ambience

  L2  Sea memory          ── SeaStateController owns it; contract unchanged
        wind-sea spectrum, maturity, foam history; remote swell untouched

  L3  Presentation        ── clouds, rain, wetness, light; read-only
```

### L0 — `WeatherState`: one record, upstream

Serialisable, finite-bounded, a deterministic function of the weather clock, a
seed and canonical position. Only fields with a real consumer:

| field | unit | consumer |
|---|---|---|
| `pressureHpa`, `pressureTrendHpaPer3h` | hPa | the barometer; generates wind and sky |
| `windSpeedMps`, `windDirectionDeg` | m/s; compass **toward**, the project convention (`WorldWind.ts:12-17`) | `WorldWind.setMean`, sea-state target |
| `gustiness` | 0–1 | `WorldWind`'s temporal point-gust input |
| `gustExcessMps`, `gustPatchMetres`, `gustPeriodSeconds` | m/s, m, s | L1's spatial field |
| `cloudCoverThreshold`, `cloudType`, `cloudCeilingM` | matching `uCloudCover`'s existing threshold semantics | `SkySystem` / `cloudCoverAt()` — the roadmap's named hook |
| `precipRateMmPerHour` | mm/h | rain density, extinction, ocean impacts, wetness |
| `visibilityM` | m | drives `hazeDistanceM`, whose clear-air value 9000 m is the neutral base |
| `electricalActivity` | 0–1 | lightning schedule (WX6) |

Wind is **derived from pressure and its gradient**, not authored beside it, so
"the glass is falling and the wind is getting up" is true by construction. That
is the whole reason to have pressure.

Named conditions are ordinary values of this record. No per-preset render path.

**The provider signature already exists in the world model.**
`docs/world/WORLD_MODEL.md:345` names the extension point for future
environment fields — `sampleEcefMps(positionEcefM, worldInstantUtcSeconds)` —
and `:69` says "Future coastlines, destinations, weather, and current fields
share this frame." Use that shape rather than inventing one.

### The clock — two thirds already decided, one third open

The briefing asked how the 30×/1× question is resolved. It resolves in three
places, and one of them is newer than every doc:

- **Astronomical calendar: 30×.** `src/world/clock.ts:11-17`, 48 real minutes
  per world day. Sail evolutions are charged against it
  (`CREW_EVOLUTION_WORLD_SECONDS`, `src/vessel/schooner/SailingControls.ts:76,116`).
- **Voyage distance made good: honest 1× by default**, 1–30 through the Voyage
  panel or `governed` by a 0.2 °/s bearing-slide budget on the nearest land
  (`clock.ts:33`, `src/world/voyageClock.ts:31-43`).
- **Weather motion: 1× wall-clock, already chosen and already judged by eye.**
  `src/scene/SkySystem.ts:44-59`, `CLOUD_WALL_RATE = 1.0`: "clouds are weather
  now, not timelapse. The sea set the precedent … The predecessor constant,
  `CLOUD_TIME_RATE`, multiplied WORLD seconds by 0.2 — a 14.4× timelapse that
  Ash read exactly as one: *'they look a bit ridiculous'*." It refuses an
  astronomical input on purpose: "Freezing a lighting condition must not freeze
  weather, and dragging the Sun across six hours must not teleport the cloud
  deck."

So *motion* is settled at 1×. What is **not** settled, because nothing has ever
had weather state that changes, is the rate at which the **state** evolves — and
it cannot inherit the motion answer. On a 1× state clock, a frontal passage is a
real half-day and the player never sees weather change. On the 30× calendar the
same passage is 24 real minutes and stays synchronised with the sky it darkens.

Recommended: the split the codebase already uses for crew work versus tiller
work — **weather *advection* on the wall clock (1×, unchanged); weather *state*
on the astronomical calendar (30×)**. Advection is a look and belongs with the
sea; a front's arrival is a calendar event and belongs with the sun. That is
decision D1.

Related and still open in writing:
`docs/terrain/TERRAIN_ROUND_HANDOVER.md:163-165` — "Ash's approach verdicts
(honest 1× vs governed, and whether the calendar should ever follow the voyage
rate) are still open." Whichever way D1 goes arguably settles that by
implication, so it should be decided knowingly.

### L1 — present forcing: keep `WorldWind`, give it space

`WorldWind` keeps its interface, seed, conventions and tests. `setMean` is fed
from `WeatherState` instead of `SeaState.wind` — a one-line change of source at
`src/runtime/VesselRuntime.ts:419` that no consumer can observe, because at a
neutral state the value is identical.

To it is added one **cat's-paw field**: low-frequency, band-limited, a function
of a stable world coordinate and time, advecting with the mean wind, documented
zero mean and bounded excursion, evaluated from **one source mirrored CPU and
GPU** with the mirror added to `tests/shader-source.test.ts`. It should absorb
`FoamField.ts:435-439`'s existing patch noise rather than sit beside it — that
field is already the right idea in the wrong place.

Readers are the ones `WorldWind`'s header has been holding back: fine roughness,
glint, whitecap *generation* gating, foam windrow orientation, spindrift bursts,
cloth, ambience. Non-readers are absolute: no Gerstner displacement, no
buoyancy, no orbital velocity, no swell.

The first bounded implementation now exists. Four integer ECEF harmonics have
documented mean zero and excursion `[-gustExcessMps, +gustExcessMps]`; their
weights sum to one. The canonical origin is wrapped on the CPU and the local
transported basis is uploaded separately, so neither an origin wrap nor a frame
rotation swings a large shader coordinate. A wrapped phase accumulator advects
the field down the mean wind at `gustPatchMetres / gustPeriodSeconds` m/s.
Current readers are deliberately only fine detail/glint, active near whitecaps,
and persistent foam injection. The wider reader list above remains WX3 work.

### L2 — sea memory: unchanged, driven from above

`SeaStateController` and `WaveField` keep their contract exactly.
`WeatherState` computes a wind-sea *target* in the existing record's own terms
and hands it to the existing transition over a sea-like duration. Phase carries
as it already does. Remote swell is never written by weather.

Sitting upstream is what preserves the memory: the memory *is* the interpolation
that already exists.

The double-count hazard is settled by rule: **the far-field whitecap statistic
reads the sea's own developed wind (`spectrum.ts:738`,
`ProductionSimulationRuntime.ts:219`); the near-field generation gate reads
present wind × the sea's response coefficients.** They agree at equilibrium and
diverge during a build, which is correct and is the point. The four
direct-`seaState.wind` readers in §2.1 are the exact seam to re-point or
knowingly leave.

### L3 — presentation

- **Clouds.** Take `CLOUD_STRUCTURE_HANDOVER.md`'s type channel: `WeatherState`
  writes `(cover, type, ceiling)`, `cloudProfile` interpolates per-type height
  gradients. No second march, no new deck.
- **Cloud shadow on the water.** `GRAPHICS_TODO.md:54-70`'s per-pixel slab
  sample, riding `uCloudEvolve` as well as `uCloudOffset`. The best single
  "weather over water" item in the backlog.
- **Rain.** Near streaks in world space; a far term as extinction plus
  cloud-base darkening rather than a second particle system; ocean response as a
  high-frequency roughness and ring layer in the water's parameter space, never
  in `WaveField`.
- **Wetness.** Generalise the `HullWetBand` idiom — mask × darkening × roughness
  scale — to a `wetness` scalar per material group with accumulate and dry
  constants. Bounded, and explicitly not a fluid.
- **Consequence, not just look.** Rain through an open `hatchwayBoards` or
  `foreScuttleLid` is where weather can reach the player's decisions with
  machinery that already exists. Deadlights are the same shape.

---

## 5. Decisions that are Ash's

**D1 — What clock does weather *state* run on?** Motion is settled at 1× and
already judged. State is open.
*Options:* (a) astronomical 30× — a 12-hour frontal passage is 24 real minutes,
sky and sun darken together, weather becomes something a session can contain;
(b) wall-clock 1× — honest, and you would essentially never see weather change;
(c) an independent weather rate on a slider.
**Recommendation: (a), with (c) as the dev escape hatch.** Consequence of (a):
advection and evolution run on different clocks — defensible, since advection is
a look and arrival is a schedule, but a squall line will drift at 1× while its
intensity ramps at 30× and the two will visibly disagree at the extremes.
Consequence of (b): the barometer still has nothing to lead. Note this also
touches the open terrain-round question above.

**D2 — Simulated or authored?**
*Options:* (a) a small physical generator — a slow pressure series over
canonical position, wind from its gradient, cloud and precipitation from the
resulting regime, so everything agrees by construction; (b) authored named
conditions interpolated between, as the spec specifies; (c) both, authored
conditions as seeds the generator relaxes toward.
**Recommendation: (a).** Less code than (b) — one scalar field replaces six
hand-kept-consistent presets — and the only option that makes the barometer
honest. Consequence: less direct authorial control over how a given condition
looks; tuning becomes tuning a generator rather than a picture, which converges
more slowly on a specific look. If a specific look matters more than coherence,
take (c).

**D3 — Are storms scheduled or emergent?**
*Options:* (a) emergent from the pressure series under a seed; (b) scheduled on
a voyage timeline; (c) neither — dev-selected only, the spec's terminus and
today's status quo.
**Recommendation: (a).** It is what makes the sea an antagonist rather than a
setting, and it costs almost nothing on top of D2(a). Consequence: pacing
becomes tuning, and a bad seed gives a dull voyage or a punishing one — hence a
governed floor and ceiling, and a dev override that can force a condition for
capture.

**D4 — Is precipitation a render pass or a system?**
*Options:* (a) a render pass — near streaks, far extinction, an ocean roughness
term, a wetness scalar; (b) a full system reaching the interior, the closures,
the crew and visibility-as-consequence.
**Recommendation: (a) for WX5, with the wetness scalar and the closure hook
shaped so (b) is additive.** Consequence of (a): rain is beautiful and inert.
My honest read is that (b) is the round you will actually want, and that it
should be its own round after you have seen (a) working.

**D5 — Does the weather panel drive the sea by default?**
**Recommendation: coupled in play, `Independent` as a diagnostic mode.**
Consequence of the spec's default: two panels that must be kept consistent by
hand, which is the state that made the sea feel like a setting.

**D6 — How much of the spec's presentation scope do we sign up for at all?**
Lightning, thunder, six audio layers, mobile tiers and the 4K target are roughly
a third of the document. **Recommendation: defer all of it past WX4 and decide
then**, when the sky and the water have weather in them and you can see whether
a storm needs a bolt to read as a storm.

---

## 5b. Decisions taken, and by whom

**Taken on 2026-08-16 by the coordinating thread, not by Ash.** He was working
through a standing instruction to choose the recommended option rather than
stop and ask, so these are recorded as *taken* rather than *ratified*. Every one
of them is his to overturn, and overturning D1 or D2 would restart WX1 rather
than amend it. They are written down here so that the code and this document
cannot drift apart while he is away from the keyboard.

- **D1 — the weather clock: (a), the astronomical 30×, with (c) a dev rate
  slider as the escape hatch.** A 12-hour frontal passage becomes 24 real
  minutes and a session can contain weather. Accepted consequence: advection
  runs at 1× while intensity ramps at 30×, so a squall line will drift and
  intensify on different clocks and disagree at the extremes. This is the same
  split the project already lives with between crew work and tiller work.
- **D2 — a physical pressure generator, not six authored conditions.** Less
  code, and the only version in which "the glass is falling" and "the wind is
  getting up" cannot drift apart, because one is derived from the other.
- **D3 — storms emerge from the generator rather than being selected.**
  Dev-selection is where the game already is with the sea-state panel, and it is
  kept as the lab path, not the play path.
- **D4 — rain is a render pass first**, shaped so that a system which reaches
  the interior, the hatches and the decks is additive to it rather than a
  rewrite of it.
- **D5 — weather drives the sea by default in play, and is independent in the
  lab.** The spec forbids the coupling; `FUTURE_ROUNDS.md` says the coupling
  *is* the feature. The lab switch is what makes both true at once.
  **Built in WX2**: `?seaCoupling=independent` at startup, and a `Coupling`
  control in both the Weather panel and the ocean laboratory's wind section,
  coupled by default.

D6 and everything in §7 remain open and untaken.

## 6. Round plan

Six rounds, WX1–WX6. `WX` is the marine abbreviation for weather and avoids the
sailing thread's S-rounds, its finding labels (W1 is taken) and the wake
thread's WK.

Each is a self-contained checkpoint in the established style: headless evidence
and deterministic gates first, Ash's eyes before merge, a handover note at the
end. WX1 and WX2 are invisible-by-design and are written to be safe to hand to
an implementation model cold. WX3–WX5 are look rounds and need Ash in the loop.

### 0. Rules for every round (additions to the sailing plan's §0)

An implementation session starting cold reads, in order: this file → its round
section → `docs/clouds/CLOUDS_ROADMAP.md` (the beauty-first mandate, which
outranks any cost reasoning here) → §2.7 above → the handover of the round
before it. `docs/sailing/SAILING_PROJECT_PLAN.md` §0 applies unchanged and is
not restated.

1. **Run `npm test` before touching anything.** 1169/93 at the time of writing.
   **And do not trust the docs on this subject** — §2.7 lists twelve stale
   claims in this repository's own documents, several of which a weather
   implementer would otherwise build on.
2. **Do not touch** the wave field, buoyancy, hull coefficients, remote-swell
   independence, or the sea presets' *swell* records. Sea-preset *wind* records
   are touched only by WX2, and only as that round specifies.
3. **Weather never enters `CanonicalWorldState`.** It is derived from it
   (position, UTC) and lives beside it, as the sailing plan's rule 3 holds for
   controls.
4. **No second geography.** Weather fields are functions of canonical position
   through the established world/render adapter. No planar voyage accumulator,
   no camera-yaw-anchored coordinate (ADR-002).
5. **One CPU/GPU source.** Any field evaluated in both places is mirrored and
   the mirror is added to `tests/shader-source.test.ts` in the same commit, or
   the scene is lit by weather that is not on screen.
6. **Determinism.** Seeded pure functions of the weather clock. No `Date.now()`,
   no `Math.random()`. `WorldWind` is the pattern.
7. **Signs by test.** `directionDeg` is the compass heading the wind blows
   *toward* (`src/world/WorldWind.ts:12-17`). Anything new gets a pinned test
   the day it is born.
8. **Every visible thing gets a lab toggle the day it is born** — the off/on
   pair is simultaneously the perf measurement, the A/B instrument and the
   regression guard. Borrowed verbatim from
   `docs/wake/WAKE_WATER_PROJECT_PLAN.md:53-55`: no toggle, no merge.
9. **Anything visible needs Ash.** "Pixel-identical" is the only
   self-certifiable claim. Every round below names its A/B checkpoint.
10. **Evidence must be allowlisted.** `.gitignore:10` ignores `evidence/*` and
    each committed artefact is an exact-path `!` exception (`:11-62`). A round
    that writes evidence without extending the allowlist commits nothing.
11. **Perf, if claimed at all, comes from `tools/perf/` and nowhere else.**
    Paired interleaved blocks, headless Chrome with `--enable-gpu
    --use-angle=metal`, `--require-nominal-thermal`. The agent browser pane
    cannot measure GPU time; a visible window costs 3×. Report the off/on pair
    in the handover even when it passes — and note that the current baseline
    (`f3d542c`) predates several merged rounds.
12. **Surface findings in full**, in scope or not.

Known adjacent debt, not to be silently fixed in passing (report if touched):
everything in §2.7; the cloud drift discontinuity at
`SkySystem.ts:106-124`; `src/scene/WindSystem.ts`'s raft-era binary sail and
drift speed; `src/audio/Ambience.ts`'s `Math.random()` noise buffer;
`createSimHandle.ts:137` reading a different wind from production; deadlights.

---

### WX1 — The glass — **DONE** (2026-08-17)

**Goal:** one weather record that changes over hours, upstream of everything,
with an instrument that proves it. Nothing on screen changes except a dial that
did not exist.

**Build**
- `WeatherState` (§4 L0) — serialisable, bounded, cloned not shared, a
  documented unit on every field.
- `WeatherSystem`: a deterministic pressure series over canonical position and
  UTC, seeded, in the `WorldWind` idiom (a sum of incommensurate sinusoids — a
  pure function of weather time, not an integration); wind speed and direction
  derived from its gradient; cloud cover, type, ceiling and precipitation rate
  derived from the regime.
- The **provider seam**, in the shape `WORLD_MODEL.md:345` already names:
  `(positionEcefM, worldInstantUtcSeconds) → WeatherState`. This round's
  provider is the generator plus a dev override. No global fields, no fronts.
- The weather clock per D1, rate on a dev slider.
- `WeatherState → WorldWind.setMean` at `src/runtime/VesselRuntime.ts:419`,
  replacing the sea-state read, **numerically identical at the neutral state**.
- The **barometer** in the captain's cabin — the instrument
  `CAPTAINS_QUARTERS_HANDOVER.md:104-116` costed at "an afternoon's work" once
  this exists. It must be legible against what is behind it.
- A `Weather` tab in the shared launcher (`src/ui/DevTools.ts`, registered
  beside the ten panels at `src/runtime/RuntimeUi.ts:345-473`) and
  `?debug=weather`, following the established lazy-load and `Hide all`
  contracts.

**Evidence & gates:** a committed weather-series JSON (`npm run weather:series`,
allowlisted) — same seed and start instant give an identical 72-world-hour
trace; pressure, wind, cover and precipitation inside documented bounds; wind
direction continuous across 359°→1°; the derived wind at the neutral state
reproduces `CURRENT_MODERATE`'s 6.0 m/s at 144° within tolerance. Barometer
reading equals the series value at the same instant, asserted. Full suite green,
typecheck, build. **Frame output pixel-identical at the neutral state** — the
one claim this round may self-certify.

**Accept when:** Ash sits at the chart desk, watches the glass fall over a few
minutes of play, goes up on deck and finds the wind has freshened since he went
below — and can point at the dial and say the two agree. Nothing else is allowed
to have changed.

**Risks:** the temptation to make the generator meteorologically elaborate — the
deliverable is one scalar field with legible consequences, not a model. Pressure
units and the sign of a falling glass are a convention trap: pin it (rule 7).
**Size:** small-to-medium. The generator is thirty lines; the record and the
seam are the work.

#### What was built, and what the build learned

`src/weather/` — `WeatherState` (the record, bounds and conventions),
`WeatherField` (the generator), `WeatherSystem` (the provider seam and the
clock), `WeatherEvidence` (the trace and its gates). Plus
`src/debug/WeatherPanel.ts`, the barometer in `captainsDesk.ts`, a `barometer`
view in `DeskFocus`, `npm run weather:series`, and
`evidence/weather/series-baseline.json`. 37 new tests; suite 1209 green.

Four things the plan did not anticipate, all of them found by measuring rather
than by reasoning, and all recorded because each was a plausible design that
turned out to be wrong:

1. **The generator is a frozen chart advecting on one steering flow, not a sum
   of independently tumbling components.** With per-component periods the
   tendency and the gradient are two different sums over the same cosines —
   correlated, and no more. Measured across seventy-two hours, the wind rose as
   often on a rising glass as on a falling one. Setting every frequency to
   `−c⃗·k⃗` makes `∂u/∂t = −c⃗·∇u` an identity, and the committed trace now
   reports r = −0.737. That number is the round's actual deliverable: it is what
   "the glass and the wind cannot drift apart" means once it is measured.
2. **The pressure must not be anchored to standard at the start of the
   voyage.** Calibrating the glass to 1013.25 hPa sounds exactly like what a
   ship's barometer needs, and it puts the anchor wherever the field happens to
   be. The first build spent all seventy-two hours above standard: the glass
   could rise and never fall, which is the one thing this round exists to make
   it do. The pressure is centred on standard instead.
3. **The *gradient*, on the other hand, must be anchored — and the anchor must
   be slack.** The present wind is the prevailing wind plus the field's
   geostrophic departure from its anchor value, which is the correct linear
   superposition (the unresolved background gradient is exactly what makes the
   prevailing wind). But an anchor sitting on a steep gradient inverts the
   relationship: the wind then blows hardest when the isobars are flattest,
   measured at r = −0.41 the wrong way. Every component now starts at a quarter
   turn, so the field's gradient *and* its tendency vanish at the anchor. The
   voyage begins in a settled spell and the weather comes to her.
4. **The wind carries a stated gain of 0.7 and the pressure does not.** The
   geostrophic wind of a real ±20 hPa pattern at these wavelengths is a gale,
   correctly — but it arrives on top of 6 m/s of prevailing wind this field does
   not model, and at full strength every gale was doubled. One openly named
   constant, applied to the wind only, with its reason in the file.

**Sea coupling is untouched, deliberately.** WX1's base wind is still the sea
state's own, so the ocean laboratory's presets still move the wind and
`openingVoyage` still derives its heading from `CURRENT_MODERATE`'s 144°. Taking
the base away from the sea and giving the sea a memory instead is WX2 and is the
whole of WX2. *(Done. WX2 replaced the per-frame read with `recalibrateTo`,
which the laboratory calls on an explicit choice; `openingVoyage` is unchanged
and still derives the heading from the same 144°, now spelled
`generatingWind.directionDeg`.)*

#### Gate results

| gate | result |
|---|---|
| identical 72-world-hour trace on the same seed and start instant | committed; `tests/weather.test.ts` rebuilds it and requires deep equality |
| pressure, wind, cover, precipitation inside documented bounds | pass — 1000.0–1021.8 hPa, 2.27–13.19 m/s, no sample clamped |
| wind direction continuous across 359°→1° | pass — worst step 2.8° per six minutes; a 400-hour walk asserts every step < 5° and that the raw bearing does wrap |
| derived wind at the neutral state reproduces 6.0 m/s at 144° | pass, and **exactly**, not within tolerance |
| barometer reading equals the series value at the same instant | pass — both come from `barometerReadingOf`, asserted hour by hour |
| full suite, typecheck, build | 1209 passed / 26 skipped; `npm run build` clean |
| **frame output pixel-identical at the neutral state** | claimed — see below |

#### The pixel-identical claim, and its exact scope

The claim is earned at the level of the arguments, not asserted:
`tests/weather.test.ts` constructs a `WorldWind` fed from weather and one fed
from the sea state as before, and requires `Object.is` on all three inputs and
exact equality on the gust process at five instants. It holds for `neutral`
(the shipped off switch, always) and for `live` **at the anchor instant** — the
first frame of a session — because `calibratedWind` returns the base wind's own
floats when the departure is exactly zero rather than round-tripping them
through `hypot` and `atan2`.

The blast radius is closed by inspection: the only render input this round
changes is the triple into `WorldWind.setMean`. `INTERIOR_FITTINGS` has two
consumers — the geometry builder and `deckObstacles`, and every barometer solid
is `collides: false`, so the obstacle list is unchanged. The interior light bake
does not read the fitting list.

**The one intended exception, stated plainly:** there is a new instrument on the
captain's cabin lining. Inside that cabin the frame is not identical, and it is
not meant to be. Everywhere else it is.

**What is NOT claimed:** that a live session stays identical. It does not, from
the second frame on — the wind is what moves, and foam, spray, the sails and the
wind cues all read it. That is the round working, not the round leaking.

#### Owed to Ash's eye

- Whether a falling glass *feels* like anything at 30×, and whether 0.7 is the
  right wind gain. r = −0.737 says the mechanism is sound; it says nothing about
  the tempo.
- Whether the barometer is legible where it is mounted. It went timber-cased on
  the recorded contrast lesson rather than by measurement, and the position is
  the one that was cut for being out of frame before the seated view widened.
- Whether `STEERING_SPEED_MPS = 18` is the right tempo dial. It sets every
  timescale in the field.
- One GPU cost is owed and deliberately not taken: weather adds a per-frame
  five-component field evaluation on the CPU and nothing at all on the GPU, so
  the expected cost is nil. Booked for the cold-machine pass rather than
  measured on a loaded one.

---

### WX2 — The wind now, and the sea's memory of it — **DONE** (2026-08-17)

**Goal:** the wind can freshen without the sea instantly being a rough sea, and
the sea can stay rough after the wind drops. Invisible except where the two
disagree.

**Build**
- Split the meaning of `SeaState.wind`: it becomes the **generating wind of this
  developed sea** — renamed and documented, preset numbers and their numerical
  tests preserved exactly (`weather-prompt.txt:676-683` is right about this).
- `WeatherState`'s wind becomes the **present** wind and the only thing
  `WorldWind` is fed.
- `WeatherSystem` computes a wind-sea target and drives it through the existing
  `SeaStateController.set(next, seconds)` path over a sea-like duration. Remote
  swell is never written.
- Re-point or knowingly leave each of the four direct `seaState.wind` readers
  (§2.1) and the `createSimHandle` divergence; kill the three hardcoded default
  winds or document why each survives.
- Settle the double count (§4 L2) in one written formula with wind speed
  appearing once. Note `effectiveGrowthWind`'s 24 m/s knee while doing it.
- `Independent` vs `Follow weather` in the Ocean and Weather panels (D5):
  coupled by default.

**Evidence & gates:** a scripted "freshening" trace in JSON — present wind steps
up, wind-sea Hs follows on a documented lag, **remote swell height and direction
bit-identical throughout**, wave phase continuous across the transition, foam
history not erased. A "dying wind" trace showing the sea outlasting it. Every
existing sea-state, transition, foam-history, CPU/GPU parity and buoyancy test
green **without tolerance changes**. Regenerated sailing baselines
(`ship:polar`, `ship:turn`, `ship:tack`, `ship:helm`, `ship:crew`,
`wind:baseline`) committed in the same commit as the code, each delta explained
— this is the round that legitimately moves them.

**Accept when:** Ash sets the weather freshening and watches the water get
*windy* before it gets *big* — cat's-paws and darkening first, the swell
arriving minutes later — then drops the wind and watches the sea stay up. And
the reverse: clearing weather over a sea that is still rough.

**Risks:** the round that touches contracts. Wind sign and the port/starboard
tack convention are pinned by `tests/world-wind.test.ts` and the project has
burned a full round on each of two sign conventions; re-read, do not re-derive.
The regenerated polar is the hazard — if it moves by more than the wind change
explains, stop and report. **Size:** medium, and the highest-risk round here.

#### Status, before anything else

**The build is complete.** Every item in the WX2 build list above is done and
every gate below is met; nothing was left half-finished and there is no owed
work hiding further down. What is owed is *judgement* — the accept-when is
Ash's and cannot be self-certified — plus one design question, both under "Owed
to Ash's eye" at the end of this section.

Two things a reader of the git log should know:

- The round landed under a commit subject reading `WIP: interrupted by a
  session limit, snapshotted mid-build`. **That title is about the session, not
  the code.** The tree it captured was green, typechecked and built, with the
  whole suite and both evidence exports passing. Do not read it as an
  unfinished round.
- Two merge conflicts with sibling rounds were resolved by the coordinating
  thread rather than here, and both are right. `WakeSourcesEvidence`'s frame
  rotation keeps a sibling's `windAngleOffBowDeg` term and takes the renamed
  field — correct, because the frame being rotated there is the *wave field's*,
  so the generating wind is the one that belongs in it. And
  `tests/hull-spray-events.test.ts`'s "this preset is calm" assertion was
  pointed at `generatingWind` — also correct, because a preset's own record is
  exactly what says whether it is a calm preset.

#### What was built

`SeaState.wind` is **`SeaState.generatingWind`**, of type
`GeneratingWindParams`, and its documented meaning is the wind that grew this
sea rather than the wind now. Every preset number is unchanged to the last bit
and every numerical sea-state test passes untouched. `src/ocean/WindSeaMemory.ts`
is the new file: the memory, the formula, and the coupling that drives the sea
through `SeaStateController.set(next, seconds)`.
`src/ocean/WindSeaEvidence.ts` and `npm run weather:seatrace` produce
`evidence/weather/wind-sea-baseline.json`. 21 new tests; suite 1604 green,
`npm run test:full` included, with no tolerance touched.

Where everything is, for a session starting cold:

| | |
|---|---|
| the contract | `src/ocean/seaState.ts` — `GeneratingWindParams`, and a header that says what it does and does not mean |
| the memory and the formula | `src/ocean/WindSeaMemory.ts` — `WindSeaMemory` (pure), `WindSeaCoupling` (the driver), `windSeaResponseSeconds` (the lag) |
| the seam | `src/runtime/ProductionSimulationRuntime.ts`, `advanceWorldPhase` — four statements, in the order the causation runs |
| the prevailing wind | `src/weather/WeatherSystem.ts` — `recalibrateTo`, the only thing that moves it after construction |
| the traces | `npm run weather:seatrace` → `evidence/weather/wind-sea-baseline.json`; gates in `src/ocean/WindSeaEvidence.ts`, rebuilt and compared by `tests/wind-sea-memory.test.ts` |
| the off switch | `?seaCoupling=independent`, plus a `Coupling` control in the Weather panel and in the ocean laboratory's wind section |
| the readout | Weather panel: three winds one above the other, and `Ahead of sea` is the gap between the wind and the water it has built |

**The formula, which is the round.** One scalar of memory, `U_dev`, the wind
whose fully-authored sea this water currently is. Against the present wind
`U_now` the sea state written is

```
U*  = max(U_now, U_dev)        the wind now working on this sea
r   = U_dev / U*               ∈ (0,1]; exactly 1 unless it is freshening
m*  = m_base · r^1.6           the sea's development under that wind
Hs  = Hs(U*, m*) ≡ Hs(U_dev, m_base)
```

The last line is an identity. `spectrum.ts` gives `Hs ∝ U²·m^1.25`, so holding
the height while the wind rises by `1/r` needs `m` scaled by `r^(2/1.25)`, which
is where 1.6 comes from — it is derived, not tasted. **The wind speed enters the
height exactly once, as `U_dev`**, which is the double count settled: the height
is the memory's alone, and `U*` changes only the character. The character is
where "windy before big" comes from, and it falls out of the same substitution:
the peak period goes as `r^0.32`, `windSeaGamma` peaks up, the spread broadens,
the authored crest sharpness is carried by the same difference
`windSeaSteepnessFor` would have moved, and `whitecapCoverage(U*)` — the
far-field statistic, read from the sea's own record as §4 L2 requires — jumps
with the wind, because that is what a fresh wind does to water immediately. On a
dying wind `U* = U_dev`, `r = 1`, `m* = m_base`: the sea is exactly the sea it
was, and only `U_dev` decays.

**The 24 m/s knee, noted as asked.** `resolveSeaState` hands the growth laws
`effectiveGrowthWind(U)`, not `U`. Below the knee that is the identity and the
line above is exact; above it the saturation is not linear, so during a build in
storm winds `Hs(U*, m*)` sits a few per cent *below* `Hs(U_dev, m_base)` — the
sea capped, which is the ceiling working. Written into `WindSeaMemory.ts`'s
header so a later round that raises the ceiling meets it.

**The lag, and why.** `τ_build = FULL_DEVELOPMENT_NONDIM · U / (g · 3)` world
seconds with `FULL_DEVELOPMENT_NONDIM = 3.5e4` — the duration-limited growth
figure, openly a chosen point in a literature that spans a factor of two, and it
puts a 10 m/s sea at about ten world hours to full development. Three e-foldings
is "developed", so the time constant is a third of that. `τ_decay = 2.5 ·
τ_build`, because a building sea is limited by how fast the air can feed it and
a dying one mostly does not lose its energy at all, it turns into swell and
walks away. The memory relaxes on **weather** seconds (the 30× calendar times
the panel's rate); the duration handed to `set(next, seconds)` is in
**presentation** seconds and is only the smoothing between commands, never the
memory.

**Why the command cadence is what it is.** `SeaStateController`'s ease is a
smoothstep whose rate is zero at both ends, so a command restarted well before
it finishes barely moves the sea — the movement per restart goes as the *square*
of the fraction elapsed, and a naive "re-command whenever the target moves"
scheme stalls completely. Each command's duration is therefore the interval
actually observed since the last one, clamped to 1–20 s, so each ramp lands as
the next is issued. Below a deadband of 0.01 m/s, 0.1° and 0.002 maturity
nothing is issued at all, which is what keeps a settled spell free: no
transition, no `applySeaState`, and the frame the game had before this round.

#### Every reader of the renamed contract, and the divergence

The complete inventory, so a session picking this up cold does not have to
re-derive it. `grep -rn "generatingWind" src/ tests/ tools/` is the whole list
and it is short; the ones with a *decision* attached are these.

| reader | verdict |
|---|---|
| `Waves.ts` breaking threshold ← wind speed | **left, knowingly.** The threshold is calibrated against Monahan coverage *for this sea*, and it is computed inside `applySeaState` from the state. It now moves with `U*`, so it answers a freshening at once — which is correct. |
| `Waves.ts` Cox–Munk slope ← `effectiveGrowthWind(wind)` | **left, and reported.** Cox–Munk is a *present-wind* regression and would ideally read the present wind, but it is computed inside `applySeaState`, which has no access to it, and plumbing one in would move the CPU/GPU parity contract. Under the new formula it reads the present wind during a build and lags on the way down. See "what is owed". |
| `ProductionSimulationRuntime` ambient whitecap coverage | **left, deliberately** — §4 L2's rule, the far-field statistic reads the sea's own record. |
| `WakePresentationController` ×2 | **re-pointed** to `WorldWind.meanSpeedMps`. `wakePolicy`'s `windMixing = smoothstep(windSpeedMps, 4, 18)` is how fast the air is tearing this frame's trail apart, which a fresh breeze does now and yesterday's leftover sea does not. Its sea-side term arrives separately and correctly as `ambientWhitecapCoverage`. The controller's `seaStates` port is gone, replaced by a `presentWind` one. |
| `createSimHandle.ts:137`, WX1's divergence-in-waiting | **closed.** The facade handed foam `sea.wind.speedMps` where production hands `worldWind.meanSpeedMps`. `tests/sim-handle.test.ts` now gives the fixture a world wind that is *deliberately different* from the sea's, so the assertion proves the fix rather than restating it. |
| `Ambience` / `SoundSampler` | **not a reader** — checked, in case the rename had missed one. It takes `whitecapCoverage` and the vessel's apparent wind, both of which are already the right wind. |
| `openingVoyage`, `WorldWindEvidence`, `WeatherEvidence`, `export-presets` | **renamed only.** All four want the sea's authored wind and get it. `openingVoyage` still derives the starting heading from `CURRENT_MODERATE`'s 144°, unchanged. |
| `OceanLab`, `hud/panels/OceanPanel` | **renamed only**, and both now carry decision D5's switch (the lab) or drive it through the choice hook (the HUD). |
| `WakeSourcesEvidence` | **renamed only, and a seam to watch.** It reads the sea's wind for the wake policy's `windSpeedMps` and for its foam wind direction, where production now reads the *present* wind for both. That is not a fault today — this harness builds its own world with no weather in it, so its two winds are the same number by construction — but it is now a place where the harness and the game read different fields, and a later round that gives the harness weather has to re-point it. Same species as the `createSimHandle` divergence, caught before it could bite. |

`sea.generatingWind.gustiness` still reaches spray and the exact zero-amplitude
foam compatibility arm. That is a **knowing leave** in this bounded WX3 half:
spindrift is outside its requested consumer set, while the old foam calculation
must remain byte-for-byte reachable for the visual A/B. At positive spatial
amplitude, foam reads `WeatherState.gustExcessMps` through the shared field and
does not evaluate the old `gustiness` noise. `WindSeaMemory` still does not
write gustiness into its target.

#### The three hardcoded default winds — all three killed

`FoamField`'s `uWindSpeed = 6`, `Ocean`'s `uWindStrength = 6.0` and
`WindSystem`'s `headingDeg = 68 / strength = 6.0` are now zero, with the reason
in each file. They were only ever alive between construction and the first
publish, and every one of them is overwritten before a frame is drawn — but 6
m/s at a plausible bearing is exactly the kind of default that stands in for a
wind that failed to arrive and is never noticed. Zero is a fault anybody would
see. `uWindDir` stays a unit vector, because it is used as a direction and not
as a velocity.

#### Gate results

| gate | result |
|---|---|
| scripted **freshening** trace, committed | `evidence/weather/wind-sea-baseline.json`. Present wind 6 → 14 m/s over five real minutes, veering 144° → 170°. |
| wind-sea Hs follows on a documented lag | τ = 4.62 world hours (9.2 real minutes at 30×). Hs 0.180 → 0.913 m against an equilibrium of 0.982 m. Halfway **331.5 s after the wind had arrived**; at the instant of arrival the sea stood at **0.34×** the height that wind implies. |
| the water is windy before it is big | at that same instant the whitecap statistic was **99.3 %** of the way to its new value against the height's **19.3 %**. |
| scripted **dying** trace | 12.5 m/s mature sea, wind falls to 4 m/s over five real minutes. τ = 10.32 world hours (20.6 real minutes). At the instant the wind had gone the sea stood at **8.30×** the height that wind implies, and half an hour later it was still 1.66× it. |
| **remote swell height and direction bit-identical throughout** | pass, by `Object.is` on all seven swell fields of both partitions in every sample of both runs. Guaranteed by construction: the target is a clone of the base with two fields written. |
| wave phase continuous across the transition | pass, and better than the bar. Measured as the worst single-step probe elevation change over four fixed world points, divided by that step's own `Σ\|aᵢωᵢ\|·dt` — and compared against **the same script run with the coupling `Independent`**, which never transitions at all. Coupled 0.790 against a control of 0.813 (freshening) and 0.587 against 0.643 (dying): the transitions add nothing measurable. |
| foam history not erased | pass. No command snaps (shortest duration 1.00 s and 1.55 s), the seed never changes, and every `whitewater` field is bit-identical throughout. |
| a settled spell costs nothing | pass — zero commands issued in either run's first two minutes, asserted. |
| every existing sea-state, transition, foam-history, CPU/GPU parity and buoyancy test | green, **with no tolerance changed**. `npm test` 1577 passed / 27 skipped; `npm run test:full` 1604 passed, 0 skipped, against 1556/1583 before the round. |
| `ship:polar`, `ship:turn`, `ship:tack`, `ship:helm`, `ship:crew`, `wind:baseline`, and `ship:voyage` for good measure | **regenerated, and byte-identical.** The polar prints its own point-by-point comparison against what is committed and every one of the 65 points reads `+0.00`. See below. |

#### The baselines did not move, and that is a finding

The round brief expected to be regenerating sailing evidence and warned about
the S6c coefficient round having moved it hours earlier. It regenerated cleanly
and **not one byte changed**, which is worth writing down because it is a fact
about the architecture rather than luck:

- the sailing harnesses do not read the sea's wind at all. `SailingCrewEvidence`
  and `SailingSteeringEvidence` construct a `WorldWind` and call
  `setMean(6, 90, …)` explicitly; `SailingPolarEvidence` sweeps its own wind
  grid. The sea state reaches them only as a `WaveField`. So the wind split is
  invisible to every one of them by construction;
- `wind:baseline` does read the presets — but through `preset.generatingWind`,
  and the rename preserved every number, so the trace is identical.

The gate the brief actually wanted — "if a baseline shifts by more than the wind
change explains, stop and report" — is therefore satisfied in its strongest
form: nothing shifted at all.

#### Owed to Ash's eye, and one design question

- **The accept-when itself.** Set the weather freshening and watch the water get
  windy before it gets big; drop the wind and watch the sea stay up. The numbers
  above say the mechanism is there and say nothing about the tempo. τ is 9 real
  minutes to build and 21 to lie down at these winds, which is a long watch —
  `FULL_DEVELOPMENT_NONDIM` is the one dial, and the weather panel's rate slider
  is the way to try other tempos without a rebuild.
- **A preset's authored maturity caps how big a freshening wind can make its
  sea, and this is the round's real design question.** `CURRENT_MODERATE` says
  `maturity: 0.28` — this water is fetch-limited — so even a sustained 14 m/s
  builds its wind sea only to 0.98 m. That is correct physics for a fetch-limited
  sea and it is what preserves the preset at rest, but if the intent is that a
  freshening wind eventually builds a *big* sea, the presets' maturity is the
  dial, or a later round has to make maturity a duration state too and give up
  the clean identity above. `SOUTHERN_OCEAN_ROUGH` at 0.80 behaves quite
  differently. **This one wants a decision before WX3 leans on it.**
- **Cox–Munk still reads the sea's wind** (above). During a build that is the
  present wind and right; on a dying wind the statistical roughness stays up
  with the sea rather than falling with the air. Whether that reads correctly is
  an eye question.
- **The far-field whitecap statistic on a dying wind.** By §4 L2's rule it reads
  the sea's record, which decays on τ_decay — so whitecaps fade over twenty
  minutes rather than with the wind. Defensible (a big sea keeps breaking for
  hours) but it is a look call.
- **No performance measurement was taken**, as instructed — the machine is
  thermally throttled. One number is genuinely owed and is new to this round:
  with the coupling active and the weather moving, `SeaStateController` is
  transitioning more or less continuously, so `WaveField.applySeaState` and
  `Ocean.refresh()` run **every frame** instead of only when somebody presses a
  preset. The deadband keeps a settled spell free, but a moving front is not a
  settled spell. Book it for the cold-machine pass, off/on through
  `?seaCoupling=independent`.

#### Reported in passing, not fixed (house rule 12)

- **`blendSeaState` drops `frozen` and `slotOverride`.** Neither is in the
  interpolated record. This was harmless while transitions only happened when a
  preset button was pressed, because a preset button snaps; it stops being
  harmless the moment the sea is in transition whenever the weather moves.
  `WindSeaCoupling` walks around it — it refuses to drive any `DIAGNOSTIC` or
  `frozen` state at all, which is independently right — but the underlying fault
  is in `seaState.ts` and belongs to whoever owns that contract.
- **`FLAT` is marked `PLAYABLE` and is not.** Its own note says it "exists so
  the buoyancy harness has a zero against which any residual motion is
  unambiguously a bug", and the browser buoyancy lab runs the production loop,
  so a coupled weather would have grown a wind sea on it and taken that zero
  away. The coupling therefore also refuses any state whose authored generating
  wind is exactly zero — if the author wrote no wind there is nothing here to
  remember. The mislabelled `purpose` is left as it is and reported.
- **`blendSeaState`'s name and label** now collapse when both sides are the same
  sea (`X->X` became `X`), because a sea morphing between two developments of
  itself is not going anywhere and every readout and benchmark caption said it
  was. Cosmetic, and changed here because this round is what made it constant.

#### What WX3 should do first

In order, and the first two are not the ones the WX3 build list starts with.

1. **Get Ash's verdict on the tempo and on the fetch question**, before
   building anything. The fetch question in particular — whether a freshening
   wind is supposed to build a *big* sea or a *steeper* one — decides whether
   `WindSeaMemory`'s single-scalar formula survives WX3, and it is much cheaper
   to answer now than after a gust field is layered on top of it.
2. **Watch the sea while the weather moves, with the Weather panel open.** The
   readout puts the three winds one above the other — the wind now, the wind
   working on the sea, and the wind the sea was grown by — and `Ahead of sea`
   is their gap. If any of WX2 is wrong on the water, that is where it shows,
   and it costs a minute.
3. **Then start on the gust field.** The 2026-08-18 first-half checkpoint has
   now taken the bounded presentation slice of both items:
   - **`gustiness` is still the sea's, and still nobody's.** WX1 passes the
     prevailing value straight through, `WindSeaMemory` does not write it, and
     foam and spray still read `sea.generatingWind.gustiness` because the ocean
     lab's slider drives them. WX3 is the round that earns the right to move
     it, and when it does, that reader is the one to re-point.
   - **`WeatherState.gustExcessMps`, `gustPatchMetres` and
     `gustPeriodSeconds` are derived, bounded and live.** The Weather panel
     exposes m/s, metres and seconds. Foam injection and Ocean detail/near-live
     whitecaps consume one retained field frame; spray remains staged.
4. **Do not re-point Cox–Munk casually.** It is the one reader left on the
   wrong wind (see the table), and moving it means plumbing the present wind
   into `WaveField.applySeaState`, which is a change to the CPU/GPU parity
   contract. If WX3 wants it, it should be a stated sub-round with the parity
   probe re-run, not a line changed in passing.
5. **The perf number WX2 booked is WX3's to collect on the same cold pass**, if
   there is one: with the coupling live the sea transitions continuously, so
   `applySeaState` and `Ocean.refresh` run every frame while the weather moves.
   `?seaCoupling=independent` is the off arm and it is already wired.

What WX3 **inherits and can rely on**: the present wind is a single authority
with one publish site; the sea has a memory with one scalar of state and one
written formula; `?seaCoupling=independent` gives an off switch for the whole
coupling; and the two committed traces will fail loudly if a later round breaks
remote-swell independence, wave-phase continuity or foam history, because all
three are gated by `npm run weather:seatrace` and rebuilt by
`tests/wind-sea-memory.test.ts` on every run.

---

### 2026-08-17 vertical MVP checkpoint — **IMPLEMENTED, LOOK VERDICT OPEN**

An explicit integration request took a narrow vertical slice across the serial
roadmap after WX2. It did not declare the larger WX3–WX6 rounds complete.

- Authored `clear`, `rain`, and `storm` records enter through `WeatherSystem`;
  they do not switch presentation effects independently.
- Existing `uCloudCover` and ocean `uHazeDistance` seams now consume the same
  record. Large preset cover jumps request one coherent cloud-cache rebase.
- Near rain is deterministic, camera-local in extent but periodic/world-anchored
  in phase, and leans from instantaneous `WorldWind`.
- Seeded lightning schedules fixed strikes; thunder is released from the same
  event after `distance / 343 m/s`. A manual review strike uses the same queue.
- The optional in-world vector reads instantaneous direction and magnitude
  directly from `WorldWind`; it owns no wind setter or clock.
- Independent presentation kill switches remain in the Weather developer tab,
  while `?weather=off` is the whole-state neutral A/B.

Still open in the roadmap at that checkpoint: WX3's spatial cat's-paws/sun
pools; WX4 cloud type/ceiling profiles; WX5 far rain, ocean impacts, wetness and
consequences; WX6 in-cloud illumination/exposure acceptance. Exact gates and
review items are in the MVP handover.

### 2026-08-18 WX3 first-half checkpoint — **IMPLEMENTED, LOOK VERDICT OPEN**

This deliberately completes only the shared field and its minimum ocean
presentation readers, not the whole WX3 list.

- `CatsPawField` is the single CPU/GPU source: four integer ECEF harmonics,
  seeded, band-limited, mean zero and bounded to `[-1, 1]`.
- `WeatherState` supplies physical `gustExcessMps`, `gustPatchMetres` and
  `gustPeriodSeconds`; the Weather panel edits those units directly.
- Wrapped canonical origin plus a separate transported local basis prevents
  large-coordinate precision loss and rotating-lattice marquee. Downwind
  advection is a wrapped integrated phase, not `direction × absolute time`.
- Ocean detail normals/glint, active near whitecaps and persistent foam
  injection share the same retained frame. Far statistical whitecaps still
  read the developed sea, per L2.
- Zero physical amplitude leaves Ocean arithmetic untouched and selects the
  exact pre-WX3 foam block. Full amplitude has no import or write path into
  `WaveField`; focused tests keep buoyancy and orbital velocity bit-identical.
- CPU/highp-Float32 agreement is gated at `2.5e-5`, with fixed-seed, mean,
  extrema, wrap, canonical-origin, transported-rotation and reset tests.

Still open from this first-half checkpoint: Ash's zero/full-amplitude water
verdict; spatial spindrift, cloth, ambience and windrow-orientation readers;
and the rest of WX3's capture matrix. The subsequent bounded sun-pool slice is
recorded below. Rain consequences and WX4–WX6 remain outside these slices.

### 2026-08-18 WX3 moving-sun-pool checkpoint — **IMPLEMENTED, LOOK/PERF VERDICTS OPEN**

- One ocean-fragment density sample halfway along the bounded slab ray reads
  the existing cloud shape, cover threshold, drift offset and evolution axis.
  There is no loop, second cloud march, texture allocation, cloud clock or
  shadow state.
- The sampled transmission replaces the existing scalar only inside the direct
  ocean-sun gate, so glitter, body light, crest scatter and foam stay coupled.
  Reflected sky, moon, wave motion and far statistical whitecaps are unchanged.
- The field uses horizontal water coordinates relative to the observer, the
  same origin as the directional cloud deck. CPU tests prove continuity under
  an equal-and-opposite observer-origin rebase.
- `?weather=off`, runtimes without weather and the uniform's zero value take
  the exact scalar path. A 1.8–3.2 km hand-off returns to that same scalar, with
  a hard exact bypass at and beyond 3.2 km.
- A public one-sample CPU mirror supplies deterministic field tests. Source
  gates lock CPU/GLSL geometry, offset, evolution, Beer-Lambert path, one-sample
  budget, zero-first branch and far-horizon bypass.

Still open: Ash's embodied/outside/high-camera judgement of scale, contrast,
speed and hand-off; an off/on GPU timing pair; vessel/deck spatial cloud
occlusion; and all wider WX3 consumers named above. Browser automation was
denied for this slice, so no visual claim is implied by the green code gates.

---

### WX3 — Cat's-paws and the moving pool of sun

**Goal:** the first round you can see. The wind becomes spatial and the sky
starts putting light on the water.

**Build**
- One spatial gust field (§4 L1), absorbing `FoamField.ts:435-439`'s existing
  patch noise rather than sitting beside it. Band-limited, stable world
  coordinates, advecting with the mean wind, documented mean and bounded
  excursion, one source mirrored CPU/GPU into `tests/shader-source.test.ts`.
  Controls in physical terms — patch size in metres, time scale in seconds, gust
  excess — never an unexplained `gustiness` scalar alone.
- Wire it, and `WorldWind`'s built temporal gusts, into the consumers its header
  has been holding them back from: fine roughness, glint, whitecap generation
  gating, foam windrow orientation, spindrift bursts, cloth, ambience gain.
  (Ambience currently reads no wind at all — this is where that changes.)
- **Patchy sun occlusion on the water** — implemented as one density sample at
  the bounded slab ray's midpoint, riding `uCloudEvolve` as well as
  `uCloudOffset`; visual scale, contrast and GPU timing remain review gates.
- Lab toggles for both, per rule 8.

**Evidence & gates:** gust-field repeatability under a fixed seed; mean within
tolerance of zero and extrema bounded over a large sample; **continuity across
every wrap and origin boundary** — the foam-marquee lesson, where a live
direction rotating a large lattice coordinate was the bug, with the existing
`src/scene/foamStreakFrame.ts` latch as the required path for any rotating
grain; CPU/GPU agreement within a documented tolerance at shared sample points;
buoyancy and orbital-velocity traces **bit-identical** with the gust field at
full amplitude. Off/on perf pair for the sun-occlusion sample.

**Accept when:** Ash stands on deck in broken cloud and watches a pool of
sunlight sweep across the water toward him while a dark cat's-paw crosses the
other way — and the ship's motion does not change as either passes. He must also
confirm the water at zero gust amplitude is unchanged from today.

**Risks:** tiling and wrap pops, which this project has already paid for once;
the gust field becoming a second whitecap authority; the sun-pool sample failing
to ride the evolve axis, so pools slide without changing shape. **Size:**
medium.

---

### WX4 — The sky the weather implies

**Goal:** overcast exists. A weather state produces a sky, rather than the sky
being independent decoration.

**Build**
- The **type channel** on the cloud weather map
  (`CLOUD_STRUCTURE_HANDOVER.md:70-83`): `cloudProfile` interpolates between
  per-type height gradients — stratus flat and wide, cumulus the present curve,
  cumulonimbus filling the slab. No second march, no new deck. Promote the
  altitude constants to uniforms as `lib.ts:834-837` already anticipates.
- `WeatherState` writes `(coverThreshold, type, ceiling)` through
  `cloudCoverAt()`.
- Overcast lighting through the terms `docs/graphics/WORLD_LIGHTING_DESIGN.md`
  already defines — direct sun down, sky fill relatively up, shadows softened —
  not a grade. Note the standing measurement that daylight already reads
  over-filled (key:fill 4.8:1 where a clear day is 7–10:1,
  `TimeOfDay.ts:933-954`): do not fix it here, do not make it worse.
- Weather-driven visibility on top of the clear-air 9000 m base, distance-aware
  through the existing `uHazeDistance` path.
- Cloud slots transition by weight, never by reseeding.
- **Check the exposure interaction explicitly**: the meter reads
  `skyWithClouds()` but not lamp light, so a darkening sky opens the meter and
  brightens the lantern (`CAPTAINS_DESK_HANDOVER.md:66-71`). Whether that is
  wanted is a question for Ash, not a bug to silently damp.

**Evidence & gates:** a weather contact sheet in the established idiom — the
condition set × high sun / low sun / moonlit night, one deliberate shot list,
captured through `npm run inspect:view` or the capture server. Cloud CPU/GPU
mirror test green with every new constant. Transition test: no discontinuity in
cover, ceiling or transmittance across a state change; no seed interpolation.
Celestial-attenuation tests still green. Off/on perf pair on the bake.

**Accept when:** Ash looks up under a marine overcast and believes the ceiling —
a lid at a height, not a grey wash — then transitions to fair cumulus and back
without the sky scrambling, and confirms the clear-weather sky is unchanged from
today.

**Risks:** three, all specific.
**(i) The horizon band (§3.4f) will be more visible under overcast than under
clear sky, and this round cannot fix it** — the one fix on record was rejected
on look. State it up front and expect it in review.
**(ii) Deeper slabs re-expose step banding.** `dt` already saturates at
`CLOUD_STEP_MAX = 150 m` below ~20° elevation and 192 steps is what buys the
current cleanliness; a cumulonimbus that fills the slab lengthens the segment.
**Do not re-add a march-start dither** — `lib.ts:1328-1346` records why it was
deleted, and that a *temporal* jitter under TAA is the only version worth
having.
**(iii) Any anisotropic field** (squall lines, rain shafts, a high deck) needs a
**per-axis** Nyquist fade, not an isotropic one. That cost a sunset once already.
**Size:** medium-large.

---

### WX5 — Rain — **NEAR-RAIN MVP BUILT; FULL ROUND OPEN**

**Goal:** it rains, the water shows it, and the ship gets wet.

**Build**
- Near rain: world-anchored streaks, slanted by the present wind at height,
  density from `precipRateMmPerHour`, no camera-fixed pattern, no per-frame
  allocation.
- Far rain: extinction plus cloud-base darkening, spatially tied to
  precipitating cloud rather than a uniform curtain. Not a second particle
  system.
- Ocean response: a high-frequency roughness and ring layer registered in the
  water's parameter space, coexisting with foam. Never in `WaveField`, never in
  buoyancy, never in orbital velocity — asserted, not asserted-by-comment.
- Wetness: generalise `src/scene/HullWetBand.ts`'s mask × darkening ×
  roughness-scale idiom to a `wetness` scalar per material group with
  accumulate and dry constants. Bounded. Not a fluid.
- Rain audio as a single gain on the existing hiss node. Nothing more (§3.6.8).
- The consequence hook: rain through an open `hatchwayBoards` or
  `foreScuttleLid`. **Scope this with Ash before building it** — it is where D4
  turns into a decision.

**Evidence & gates:** precipitation interpolation endpoints and continuity;
wetness accumulates and dries continuously, bounded in [0,1]; a registration
test proving the ripple layer does not slide across displaced waves; buoyancy
and orbital-velocity traces bit-identical with rain at maximum; no per-frame
allocation over a 60 s soak. Off/on perf pair.

**Accept when:** Ash stands on deck in heavy rain and it reads as rain — falling
at rain's speed, leaning with the wind, hitting the water — and he can watch the
deck darken and then dry after it passes. Explicit A/B against the dry scene at
the same instant.

**Risks:** rain against a bright sky and rain at night are two different
problems and the second usually fails; ring ripples sliding over waves is the
registration failure this project has met twice; the near/far seam is where
every rain system shows its edge. **Size:** large — split into 5a (sky-side rain
and visibility) and 5b (water response and wetness) rather than letting the
checkpoint sprawl.

---

### WX6 — Thunder — **SCHEDULE/AUDIO MVP BUILT; LOOK ROUND OPEN**

**Goal:** contingent, decided at the close of WX4 (D6). A storm that needs a
bolt to read as a storm gets one.

**Build (if taken)** a deterministic seeded event schedule with irregular
intervals; in-cloud illumination through the existing cloud volume rather than a
screen flash; occasional distant cloud-to-ocean bolts, spatially fixed for the
duration of the flash; speed-of-sound thunder delay from strike distance;
exposure recovery that does not pump.

**Evidence & gates:** no events at zero activity; identical schedule under a
fixed seed and reset; thunder delay strictly increasing with distance;
manual-trigger determinism; no shader-compile hitch on the first event.

**Accept when:** Ash watches a storm from the deck at night, a flash reveals the
inside of the cloud and the surface of the water, and the thunder arrives late
enough that he counts.

**Risks:** the exposure interaction. The meter's behaviour under a 100 ms
two-stop transient is unknown, it already cannot see lamp light, and both ends
of the day are pinned near its clamp (`TimeOfDay.ts:1101-1110`). **Size:**
medium.

---

### Sequencing

```
WX1 ──► WX2 ──► WX3 ──► WX4 ──► WX5 ──► WX6?
         │                │
      D5 here        D4 and D6 here
         └──── 2026-08-17 narrow vertical MVP ────┘
```

The full rounds remain serial. The MVP is a recorded exception: it proves the
end-to-end state/presentation/audio path without claiming the omitted depth of
WX3–WX6. Future work resumes at the open gates above rather than treating an
MVP effect as completion of its parent round.

### What "done" means for the whole project

A voyage has weather the captain did not choose. The glass falls, the swell
comes round, the wind freshens, the sea builds behind it, the sky goes over, it
rains, and the whole thing passes — and every one of those is the same weather
record seen through a different system, not six effects switched on together.

---

## 7. What this round did NOT decide

- **Any of D1–D6.** They are Ash's and they are the point of this document.
- **The visual character of any condition.** No claim is made here about how
  anything will look; I cannot see the game, and house rule 7 says only
  "pixel-identical" is self-certifiable.
- **The exact form of the pressure generator.** WX1 recommends the `WorldWind`
  idiom; sinusoid sum versus filtered walk versus low-order synoptic model is an
  implementation choice inside that round.
- **The horizon cloud band.** Diagnosed, fix rejected on look, still open; WX4
  will make it more visible.
- **Whether a high deck comes back.** The cirrus deck was deleted for look, not
  cost, and the recipe survives. A weather round wanting cirrostratus is
  building it, not re-using it — and that was not scoped here.
- **The cloud drift discontinuity** at 4,000,000 m (~7 h of play). Found while
  reading; reported under rule 12; not scheduled.
- **The open +21.4% performance regression.** Unclosed, and this plan does not
  close it. Every round adds cost to a frame already ~3 ms over its last good
  baseline — and that baseline itself predates several merged rounds.
- **Whether TAA happens first.** It would make WX4 cheaper and better, it is on
  Ash's table, and it is the only route recorded for the horizon band. It is its
  own round and nothing here depends on it.
- **Mobile and 4K tiers.** Refused as gates (§3.6.6); still real work someday.
- **Broad weather audio.** Still deferred (§3.6.8). The MVP adds only one seeded
  thunder one-shot behind the existing ambience graph, released by the same
  lightning event after its physical delay. Rain beds and a larger weather mix
  remain sound-round work.
- **Deadlights and heavy-weather ship handling.** Named as owed debt in the
  quarters handover; weather is their precondition, not their round.
- **Whether the calendar should ever follow the voyage rate** — the terrain
  round's open question. D1 touches it; it does not answer it.
- **Global weather, fronts, currents, climatology, voyage scheduling.** Deferred
  by the spec and deferred here — but the WX1 provider seam exists precisely so
  a later round can supply them without touching anything downstream.
- **Snow, hail, ice, fog banks, rainbows, waterspouts.** Not wanted, not
  planned.
