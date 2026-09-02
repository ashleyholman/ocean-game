# Terrain round handover

Written 2026-08-06 at the end of the round's first session; updated 2026-08-18
with the depth-strategy measurements, code-round record and coarse-global
integration slice. Docs of record:
`docs/terrain/terrain-system-design.md` (design), `docs/terrain/terrain-project-plan.md`
(statuses — trust its task tables over this summary), and
`docs/terrain/terrain-r1-synthetic-spike-spec.md` (R1 fixtures/harness spec).

## Where the round stands

- **R0 is complete and approved.** Uncontended desktop baseline in
  `evidence/terrain/baseline/performance.json` (frame medians 5.5–8.2 ms at
  60 Hz, ocean pass dominant, embodied views cheapest); camera geometry in
  `camera-geometry.json` (embodied eye 3.4 m measured / 15 m planning
  envelope; near plane adaptive 0.06 → 0.25 → ~5.35 m; far 25 km).
  Budgets: `docs/terrain/decisions/R1-budgets.md` — terrain+far-ocean
  increment ≤ 1.0 ms ordinary views, ≤ 3.0 ms maximum cinematic, measured as
  same-harness increments.
- **R1-A is landed and green** (TERR-100–102): addressing-agnostic tile
  contract (`src/terrain/TerrainTile.ts`), four deterministic fixtures
  (`syntheticFixtures.ts` — bit-identical regeneration, exact shared edges
  via the fixture-wide lattice), and
  `WorldRenderAdapter.anchoredTileMatrix` (<1 mm at 5 km, <5 cm at 300 km in
  `tests/terrain-anchored-transform.test.ts`).
- **TERR-103 renders** (`TerrainSystem`/`TerrainTileMesh`): world-PBR-lit,
  seam-free lattice normals, vertex-colour scaffolding palette. Long-range
  jitter matrix (80–300 km) still to run — unblocked by `&far`.
- **TERR-110 complete**: `&far=<km>` raises the far plane (pose updates
  never write `far`); production untouched without it.
- **TERR-111–113 measured on the quiet GPU**: reversed-Z is the supported
  desktop candidate (`EXT_clip_control=true`, active reversed mode), with no
  open-water tax and a paired 21 km peak increment of 0.572 ± 0.065 ms SE.
  Conventional measured 0.594 ± 0.097 ms; log measured 1.223 ± 0.102 ms and
  exceeds the 1.0 ms ordinary-view budget. Full evidence and the provisional
  TERR-115 verdict are in `docs/terrain/decisions/depth-candidates.md` and
  `evidence/terrain/depth-candidates/performance.json`.
- **TERR-133 in progress**: terrain hazes toward the ocean's sky-radiance
  LUT, linear-HDR mix before the shared tone transform, ocean's 9 km
  extinction default, `&haze=<km>` as the visibility-distance input. Stills
  verified at 6 km and 120 km; the stability half is closed (one shared LUT
  mapping), the 20–300 km sweep remains.
- **The 2026-08-16/17 code round** closed TERR-104, TERR-130 and TERR-132,
  built TERR-131's switch and TERR-134's buckets without running either, and
  did not start TERR-135 then. TERR-135 now has its camera prerequisite,
  canonical table, deterministic CLI plan and motion checklists. Its cold pixel
  run and eye verdict remain. The record, runbook, and R1 exit tally are the last
  section of this document — **read that before planning anything**.

## Coarse global integration slice (2026-08-17)

A separately authorised, deliberately non-production vertical slice now puts
one Natural Earth coarse source behind both `DeveloperGlobe` and
`TerrainSystem`. Use `?terrain=global`; the absent/default mode remains
`synthetic` and `?terrain=off` remains the baseline. The authored opening at
the time was a city centre, and the real mask correctly put it on land (the
opening has since moved to open water off the New South Wales coast; the land
case is kept as an explicit test fixture). Explicit
global startup now resolves it through TERR-G006 before world construction;
synthetic/off retain the authored coordinates exactly. This makes global mode
usable without silently changing the shipping default or authored constants.
`TerrainSystem.update()` keys resident local preview tiles directly from the
canonical ECEF position, so World-panel teleports and ordinary travel share one
state path. The same Natural Earth rings now provide a fixed 5,004-segment
nearest-land query: exact zero on land and a finite shortest coast arc over
ocean. The global handle refreshes that value from canonical ECEF before the
voyage governor reads it.

The resolver is a pure bounded query over those same source methods: 5 km
minimum clearance, 500 m rings, 5° bearings and 100 km maximum radius. It
preserves valid water bit-identically and publishes its immutable
authored/resolved/reason/source result in both World panels. That land opening resolved
to a point 24.5 km from where it was authored with about
5.012 km coarse-source clearance. That coordinate is derived, not authored.
Search failure is an explicit startup error. This is not collision, grounding,
or navigation. Explicit-global globe clicks now use the same bounded authority:
qualified ocean stays exact, land and near-coast clicks relocate to qualified
coarse water when the lattice finds it, and deep-inland clicks reject with
visible lattice-exhaustion feedback. Open-water
shortcut buttons remain exact and clear any prior click message.

Read `docs/terrain/global-coarse-vertical-slice.md` before extending it. The
short version: Natural Earth land 4.1.0 plus sparse elevation points 5.0.0 are
pinned and hashed; the temporary 2° geographic provider has antimeridian,
pole, provider, water-qualified teleport, coast-distance, governor and globe
tests; and
**GLO-30/WBM are still `not_acquired`, with ingestion `not_started`**. This
closes TERR-G001–G006, not R2, Gate A or P1. Do not mistake its broad peak
envelopes or generalised coast for measured terrain.

## How to drive it

Dev server: `drift-terrain` launch config, port 5203. The safe shipping default
is the synthetic headland; `?terrain=global` opts into the coarse whole-world
provider and `?terrain=off` is the empty-ocean baseline:

```text
?terrain=synthetic&fixture=headland&range=6&bearing=-48
?terrain=synthetic&fixture=peak&range=120&bearing=-48&far=200&haze=80
?terrain=global
?terrain=off
```

Fixtures: `low-coast` (12 m dunes, land east of centre), `headland` (100 m,
west cliff), `mountain` (500 m cone, island radius ~4.5 km), `peak`
(3,000 m massif, island radius ~19.6 km). `range` is now vessel→nearest
above-water land, not fixture centre. Its 1 km floor prevents an initial
camera-inside mount; ordinary sailing can still close inside the fixture
because collision and grounding remain deliberately unimplemented.

R0 perf harness: `?perf=terrain-baseline&capturePort=<port>&fixedDpr=1` in
headless Chrome with `--enable-gpu --use-angle=metal`, capture server
`node tools/capture-server.mjs evidence/terrain/baseline <port>`.

## Depth-candidate harness (added 2026-08-07, second session)

`&depth=conventional|log|reversed` on any URL selects the depth strategy at
renderer construction (unknown values throw; absent = production unchanged).
An explicit `?depth=` logs a one-line capability matrix
(`EXT_clip_control`, active mode, depth bits) for evidence. All three modes
render correctly, including `?oceanTaa=1`. Full findings, the two
reversed-mode app fixes, and the three r185 renderOrder-flip bug workaround:
`docs/terrain/decisions/depth-candidates.md`. Headline: DEPTH-01's coastline
"fringe" is mode-independent shoreline content, not depth error. The quiet-GPU
comparison is complete: reversed-Z is the desktop candidate; log remains the
fallback but needs a budget recovery on platforms without clip control.

Repeat the evidence with `node tools/run-terrain-depth-benchmarks.mjs` while
the Vite server is on port 5203. The runner launches one GPU-enabled headless
Chrome at a time, executes two symmetric-order baseline and paired-occlusion
runs per mode, verifies 1600×913 DPR 1, and writes the committed aggregate.

## Traps this session paid for (do not rediscover)

1. **The agent browser pane does not composite while hidden — rAF never
   fires.** A console-driven `sim.renderFrame()` capture without prior
   stepping photographs the *construction-pose* camera at the waterline with
   uninitialised exposure (huge sun disc, "half underwater"). Recipe that
   works: set conditions, `for (k<240) sim.stepSimulation(1/60)`, then
   `sim.renderFrame()` + canvas grab in the same task, POST to the capture
   server. Eyeball every capture before trusting it.
2. **`Number(null) === 0`.** Absent URL params clamped to minimums and set a
   500 m haze distance — terrain painted as pure sky (cyan before the
   tone-anchor fix, invisible after). Fixed in `clampNumber`; keep the
   pattern.
3. **Shader injections into world materials must go before
   `tonemapping_fragment`** (linear HDR), and chain after
   `WorldPbrMaterial`'s own compile with a split program-cache key.
4. **The sky LUT's below-horizon rows are not sky** — terrain haze clamps
   sampled elevation just above the horizon.
5. OceanTemporalResolve is **off** by default (`?oceanTaa=1` opts in); the
   baseline measured production truthfully.
6. Machine contention: heavy sim suites (ship dynamics/deck) flake on 5 s
   timeouts when other workers render; terrain suites are cheap and stable.
   Verify suspicious failures in isolation before believing them.
7. A page loaded while the agent pane is hidden reports `innerWidth === 0`
   and keeps a **2×2 canvas** until the pane composites once — grabs read
   transparent black and captures ship 4-pixel JPEGs. Take one pane
   screenshot after every navigate, THEN drive via console. (Related to trap
   1 but distinct: this one corrupts geometry, not just pose.)
8. `renderer.info.render` resets per `render()` call — after a TAA frame it
   shows only the fullscreen present pass (1 call, 2 triangles). Read it
   only on the TAA-off path, or sum across passes.
9. The world instant can be moved for a capture
   (`world.setWorldInstantUtcSeconds` + `sim.refreshLighting()` +
   `sim.refreshWorldLighting()` before the shot) and daylight sets work, but
   a day→night set did not take in one late attempt this session —
   unverified why (suspect wall-anchored clock re-derivation). If a capture
   needs night, verify the sky actually darkened before trusting the shot.

## Found and recorded, not yet fixed

- **DEPTH-01 reframed (2026-08-07)**: the dashed coastline artefact at
  6–10 km is bit-identical under conventional and reversed-Z, with foam
  zeroed, through both the 0.28 m and 6 cm near planes, in stills and in
  temporal variance — it is shoreline rendering, NOT depth fighting. The
  depth-strategy case rests on far-range arithmetic (design §7). The GPU
  comparison now confirms the other half: log depth's terrain-on increment is
  ~0.65 ms above reversed-Z and breaches the ordinary-view budget in the peak
  stress case.
- Cloud/terrain occlusion (TERR-137) untested — CloudDome composites with
  `depthTest:false`; the horizon cloud band sits where distant peaks live.
- **Terrain haze mixes toward a CLOUDLESS sky.** `TerrainSystem`'s injection
  samples the bare gas-sky radiance LUT, while the pixel behind a distant
  headland is sky *plus* the cloud composite. At long range land dissolves
  into a sky that is not the sky drawn around it, and the mismatch drifts as
  the cloud field moves. Same family as TERR-137 and probably the same fix;
  recorded separately because it is a haze fault, not only an occlusion one,
  and it will look like a TERR-133 regression to whoever meets it first.
- **`low-coast`'s footprint is 8 × 4 km; the spec's table says 8 × 3 km**
  (`terrain-r1-synthetic-spike-spec.md:35` against `syntheticFixtures.ts`'s
  `tilesX: 2, tilesY: 1` at 128 cells × 31.25 m). Harmless, but the table is
  what a reader will believe.

### Fixed since this list was written

- **Stars punching through terrain** — closed by the star-dome round, not by
  this one: `STAR_DOME_FAR_FRACTION` parks the dome at 0.98 × `camera.far`
  (`src/scene/StarField.ts:74`), read per frame via
  `cameraFarM: () => cameras.camera.far` (`src/main.ts:621`) precisely because
  the terrain harness raises the far plane. **That coupling was re-checked
  against everything the 2026-08-16 round did and still holds**: the harness
  still raises `cameras.camera.far` at mount and on every range change
  (`syntheticTerrainHarness.ts`, `ensureTerrainFarPlane`), the read is still
  per frame, and the new `?terrainOrder=` switch moves terrain only within the
  OPAQUE list while the dome is transparent at renderOrder −900 — so terrain
  occludes stars in both arms. The gap worth knowing: the per-frame read has
  no automated guard, only `starDomeRadiusM`'s arithmetic
  (`tests/graphics.test.ts:353`). A harness change that cached the far plane
  would break this silently.
- **Camera-inside-fixture** — both halves now. The mount half was closed
  earlier (`range` became nearest-land distance, measured in
  `tests/synthetic-terrain-harness.test.ts`); the sailing half is closed by the
  exact live clearance readout below.
- **"Terrain colour/shading is deliberate scaffolding"** — half right, and the
  wrong half was being used to defer TERR-132. See the round record below.

## The voyage clock (2026-08-14): terrain made the timescale visible

Rendering land surfaced a design clash, not a terrain bug: the ship, sea and
sky animate at 1× while `PlanetaryWorld` moved the vessel through world
coordinates at 30×, so the first world-anchored object in view (the headland)
read as *land sliding on its own* — ~1°/s of bearing drift where a true 6 kn
passage 5 km off shows ~0.04°/s. Uniform world scaling cancels out of
ω = v/d entirely, so "shrink the planet" was analysed and rejected; the only
honest lever is speed over ground while land is in view.

What changed (all in `src/world/voyageClock.ts` + wiring):

- **Voyage compression defaults to honest 1×** (`DEFAULT_VOYAGE_SECONDS_PER_
  REAL_SECOND` in `clock.ts`). The astronomical calendar keeps its 30× day,
  and crew evolutions still convert against the *calendar* rate, so sail
  handling costs are unchanged.
- **Terrain mounts by default**: the headland at 6 km, 20° off the opening
  course's bow (derived, like the opening itself). `?terrain=off` restores
  the empty ocean — note the R0 "production baseline" predates default-on
  terrain, so future baseline comparisons must say which world they measured.
- **The voyage clock**: `?voyage=<rate>` or `?voyage=governed` +
  `?voyageOmega=<deg/s>`, live in the `?debug` shell's Voyage panel. Governed
  mode holds the nearest land's apparent drift under the slide budget
  (rate = ω_max·d/v, clamped 1–30, eased over ~2 s), so open ocean runs full
  compression and land only appears through a ramp that has already slowed
  the voyage. The panel readout shows live rate, nearest land, and apparent
  slide; Ash's approach verdicts (honest 1× vs governed, and whether the
  calendar should ever follow the voyage rate) are still open.
- The coarse global provider now measures nearest land from the same Natural
  Earth rings it renders. Central Pacific clearance reaches governed 30×; a
  tested near-coast ocean point about 0.86 km from the coarse coast slows
  below 30×; a land point stays at zero/1×. The fixed complete scan is bounded
  at 5,004 spherical segments and is explicitly not navigational clearance.

## The code round (2026-08-16/17): travel, ordering, buckets

Ran on a thermally throttled machine, so **no timing was taken and none should
be read into anything below**. Everything here is code, correctness or harness.
All of it is on `claude/coord-terrain-r1` and merged into the integration
branch; `npm test`, `npm run build` and typecheck are green.

### TERR-135 staged, not visually judged — read this before planning

**The canonical table and its capture policy are built. The pixels and live eye
verdict are not.** `src/debug/terrainCanonicalViews.ts` is the one table:
12 bounded rows, not a render-matrix cross-product. Ten rows are capture-host
recipes; two are paired A/B rows, so the full still run writes 12 atomic PNGs.
Two rows are live motion checks because a still cannot answer them honestly.

| Row ID | Named condition | Camera / evidence |
|---|---|---|
| `near-low-coast-embodied` | 1 km low coast, midday calm | Embodied still |
| `coast-low-sun-rough-sea` | 5 km headland, low Sun, rough sea | Embodied still; high-risk waterline pairing |
| `midrange-default-cinematic` | 20 km mountain, midday | Authored-default cinematic still |
| `hazy-peak-80km` | 80 km peak, long explicit haze | Authored-default cinematic still |
| `maximum-cinematic-far-ocean` | 200 km peak over far ocean | Maximum cinematic still; high-risk pairing |
| `conventional-300km-bounds` | 300 km conventional-depth control | Authored-default cinematic still |
| `temporal-resolve-identical-coast` | 20 km identical scene, ocean TAA off/on | Atomic two-arm still; high-risk pairing |
| `cloud-occlusion-peak` | 20 km peak in the cloud band | Cinematic staging only; no occlusion verdict claimed |
| `waterline-draw-order` | 5 km headland, terrain after/before ocean | Atomic two-arm still |
| `lower-power-coast` | 5 km low coast, fixed mobile tier | Embodied still |
| `slow-cinematic-orbit` | 80 km peak during one slow 360° orbit | Live checklist; no capture mode |
| `accelerated-voyage-past-mountain` | 5 km mountain during fixed 30× travel | Live checklist; no capture mode |

- The table uses `src/debug/captureHost.ts`; it does not construct another
  camera or another capture system. Absent `cameraMode` still means embodied.
  Explicit embodied/cinematic rows stage the existing controllers, and scale 1
  is the existing maximum cinematic composition. PNG metadata records actual
  mode, scale, tier, surface, switches, Sun, Moon, and point of sail.
- The four high-risk pairings each have exactly one owner: low-Sun rough-sea
  coastline, identical-view temporal resolve, maximum-cinematic far ocean, and
  cloud/peak occlusion. The last is a staging recipe, not a passed verdict.
- `tools/terrain-canonical-captures.mjs --plan` emits deterministic,
  browser-free JSON with no timestamp. `--list` exposes the same table. The
  capture action requires `--cold-machine`, refuses an existing output folder
  and any open pixel prerequisite, then delegates every render/read to
  `window.__driftCapture` and records the host's actual readback.
- A real blocker was closed before naming the 80–300 km rows: weather applied
  its 9 km neutral visibility every frame and replaced explicit `?haze=`. The
  production transaction now reapplies a terrain-only explicit synthetic haze
  after environment derivation. Sessions without `?haze=` omit the port and
  retain ordinary weather visibility. This is capture/diagnostic precedence,
  not new weather behaviour.
- `tests/terrain-canonical-views.test.ts`,
  `tests/terrain-canonical-cli.test.ts`,
  `tests/capture-host-camera.test.ts` and
  `tests/production-simulation-runtime.test.ts` pin the table, both cameras,
  high-risk ownership, page policy, ordinary visibility, and explicit haze
  surviving repeated frames. None claims that the pictures look correct.

### Closed, with the test that covers each

| Item | What changed | Test |
|---|---|---|
| **TERR-104** | The exercise itself, headless and deterministic: the real `PlanetaryWorld` geodesic integrator driven at 30× (~90 m/s) on a 16 km track past `mountain`, crossing all four of its tile-column boundaries, measuring per frame instead of at the endpoints | `tests/terrain-accelerated-travel.test.ts` |
| **TERR-104 fault** | `getNearestLandM()` was the placement solver's own offset — one number, measured on one bearing at mount — subtracted from the live centre distance forever after. Measured over four fixtures and a 25 km walk in every direction it **over-reported clearance by up to 5.07 km on `peak`** and 2.88 km on `low-coast`, always in the unsafe direction. The voyage governor divides by that number and the 500 m contact warning compares against it. Replaced with an exact coastline query (`syntheticFixtureNearestLandFromOffsetM`), ~1,100 coast samples for `peak` rather than ~30,000 land samples | `tests/synthetic-terrain-harness.test.ts` — reconstructs the old arithmetic verbatim, so a revert fails |
| **TERR-130** | `low-coast`'s dune field ran off its own footprint: **354 ring samples standing up to 11.6 m**, a vertical face down to nothing with sky behind it. The old check was `min(height) ≤ −50`, which every fixture passed — the wall and the gap are different failures. `FIXTURE_RIM_MARGIN_M` drowns the rim; all four fixtures now end submerged | `tests/terrain-fixtures.test.ts` — boundary-ring and waterline-slope tests |
| **TERR-131** | Terrain and the sea both sat at `renderOrder` 0 and three broke the tie by projected origin depth — the sea disc is centred on the camera, so **the sea has always drawn first and the land second**, shading every ocean fragment hidden behind a headland. Both arms are now explicit (`src/terrain/terrainDrawOrder.ts`), live, and registered as an A/B switch. **Defaults to `after`, the order that already shipped** | `tests/terrain-draw-order.test.ts` |
| **TERR-132** | Judged already closed, then pinned — see below | `tests/terrain-tile-mesh.test.ts` |
| **TERR-133** (stability half) | `skyRadianceLutUv` existed twice: once in `Ocean.ts` and once hand-copied into `TerrainSystem.ts` with a comment asking the next reader to keep them equal. A divergence of one texel row is not a mis-set constant, it is a seam at the waterline that moves as the vessel turns. Now one `GLSL_SKY_RADIANCE_LUT_UV` in `shaders/lib.ts`, with terrain narrowing the elevation range on top of it | `tests/shader-source.test.ts` — asserts exactly one definition and both consumers importing it |
| **TERR-134** (build only) | Profiler buckets and residency counts. Built, **not run** | `tests/terrain-draw-order.test.ts` |

TERR-104's numbers, for whoever needs a regression baseline: over 10,670 frames
and 1,068 seam checks, worst shared-edge seam 1.25e-4 m, worst reconstruction
error 5.46e-5 m, worst frame-to-frame jerk 3.57e-7 m — and **3.56e-7 m within
50 m of a tile boundary, i.e. no different**. Crossing a boundary is not an
event. 30 s at 1× and 1 s at 30× land 1.29e-6 m apart; 120 frames and 1,200
substeps land 8.38e-7 m apart.

One trap that cost time and is not obvious: `initialiseSurfaceFrame` starts the
transported frame **north-aligned regardless of `initialCourseRad`**, which
only aims the velocity vector. Displacements handed to
`advanceTangentMotionStep` are in the frame, so driving "forward" sails up the
meridian. Sail east along `right`.

### Judged already closed by earlier work — do not redo

- **TERR-132, simple slope lighting.** Its acceptance is "terrain responds
  consistently to real Sun, Moon and sky lighting", and it already does:
  `TerrainSystem` builds on `createWorldPbrMaterial`
  (`src/terrain/TerrainSystem.ts`, `createTerrainMaterial`), the same factory
  the hull uses, so sun, moon, sky probe and exposure arrive by the same path;
  and normals are real slope normals taken across the fixture-wide lattice
  (`src/terrain/TerrainTileMesh.ts:82`), not face-flat. The handover's line
  "terrain colour/shading is deliberate scaffolding" was being read as "lighting
  is unbuilt". The **palette** is scaffolding — four flat anchors, R2 materials
  own it. The **lighting** is not. What it needed was a check, so the two claims
  it rests on are now measured rather than asserted: normals compared against
  the mesh's own triangles (worst 6°, all pointing up), and bit-identical
  normals on both sides of every shared tile edge.
- **The ocean's shadow-caster twin under log depth** — landed before this round.
  `SHADOW_VERTEX_SHADER`/`SHADOW_FRAGMENT_SHADER` carry the log-depth chunks
  (`src/scene/Ocean.ts:812`), and the structural rule is enforced for every
  ocean shader that writes a position by `tests/shader-source.test.ts` ("wires
  log depth into every ocean shader that writes a position"). Verified, not
  rebuilt.
- **The mount half of camera-inside-fixture** — `range` is nearest-land
  distance and `syntheticFixtureNearestLandM` measures what the solver
  delivered, from every bearing, on every fixture.

### Blocked on a cold machine — the runbook

Nothing below requiring cold pixels or timing was run. Each action is written
so it can be executed without asking.

**1. The profiler buckets (TERR-134).** The rotation used to be five cumulative
endpoints; the `ocean` bucket therefore ran from the sky dome's draw to the
sea's and **contained the whole vessel** (hull at renderOrder −2, interior at
−1) and, until this round, terrain as well. It is now seven endpoints, so:

- `sceneOpaque` — hull, rig, fittings, interior.
- `terrain` — the tiles alone, bounded by whichever draw follows them in the
  active order, so it is terrain-only in **both** arms of `terrainOrder`. Reads
  about zero with `?terrain=off` rather than stalling the rotation.
- `ocean` — the sea alone.

Two consequences to carry: a rotation now costs **8 frames, not 6** (read
`gpuProfiler.framesPerRotation`, never write it down), and every pre-split
number — `evidence/terrain/baseline`, `evidence/terrain/depth-candidates` —
has the ship inside its `ocean` figure and **is not comparable to a post-split
one**. R0's "ocean pass dominant" was measured that way.

Run: `?perf=terrain-baseline&capturePort=<port>&fixedDpr=1` in headless Chrome
with `--enable-gpu --use-angle=metal`, capture server
`node tools/capture-server.mjs evidence/terrain/baseline <port>`. What it will
answer: how much of the 1.0 ms ordinary-view budget terrain actually spends,
separately from the sea and the ship, for the first time.

**2. The `terrainOrder` A/B (TERR-131).** Two questions, one command each.

- *Is the picture identical?* `node tools/ab-sheet.mjs --switch terrainOrder
  --diff 8 --terrain on`. Both surfaces are opaque and both write depth, so the
  resolved image should be identical — but the depth function is LESS, not
  LEQUAL, so at the waterline a tie goes to whichever drew first and the flip
  changes which one that is. DEPTH-01's dashed coastline is shoreline
  rendering and this is the one change that could move it. A clean diff is the
  evidence for turning `before` on by default.
- *What does it save?* Re-run `node tools/run-terrain-depth-benchmarks.mjs`
  with the Vite server on 5203. It now records `terrain`, `ocean`, `vessel` and
  the combined `terrainAndOceanPrefix` separately (the combined figure is kept
  because the committed 2026-08-07 evidence is quoted in that form). What it
  will answer: whether rejecting hidden ocean fragments behind land pays for
  itself, which is the whole of TERR-131's "where beneficial".

**3. The 80–300 km jitter/depth matrix (TERR-103/111/115).** Still owed, still
needs a quiet GPU. `&far=<km>` unblocks it. TERR-104 has now closed the
*numerical* half of stability under travel at fixture range; this is the
long-range visual half.

**4. TERR-133's 20–300 km haze sweep.** The stability half is closed by the
shared-UV test; the sweep is a look question at range and needs the quiet GPU
and Ash's eye.

**5. The lower-power/browser tier.** Reversed-Z capability plus the log
fallback's cost. Needs hardware nobody had here.

**6. TERR-135's canonical pixels and motion verdict.** The browser-free plan
and Node syntax check ran; the active shared machine was not a cold, quiet
evidence host, so Chrome was deliberately not started. On a cold machine, from
the repository root, run exactly:

```text
node tools/terrain-canonical-captures.mjs --capture --cold-machine \
  --out evidence/terrain/r1-renderer/terr-135-canonical-cold
```

The output directory must not already exist. Expect 12 PNGs plus
`terrain-canonical-manifest.json`; verify its revision/dirty flag, actual camera
and tier readback, then judge every still. Afterwards run the two motion URLs
and checklists printed by `--plan`. Do not promote the staging-only cloud row to
an occlusion verdict, and do not call TERR-135 complete until both passes are
recorded.

### What remains before R1 can exit

R1's exit criteria are plan §6. Standing against them now:

- [x] ECEF-anchored geometry stable during accelerated travel — TERR-104.
- [x] Synthetic land intersects ocean without a wall or a gap — TERR-130.
- [~] One depth strategy across the 6 cm near plane and long terrain range —
      reversed-Z chosen on desktop; the 80–300 km matrix and the low-power
      capability check remain.
- [ ] Detailed ocean curvature agrees across all passes — TERR-120+, not begun.
- [ ] Maximum cinematic view has a correct curved sea horizon — TERR-120+.
- [ ] Detailed/far-ocean transition invisible in stills and motion — TERR-123/125.
- [ ] Cloud/terrain occlusion has a chosen mechanism — TERR-137, blocked.
- [ ] Ordinary embodied/default views within the R1 budget — the buckets now
      exist to answer this; the number does not.
- [ ] Maximum cinematic incremental cost measured and accepted — needs both a
      cold machine and the cinematic capture path above.
- [ ] No unresolved renderer issue makes a real-data spike wasteful.

**R2 is not authorised until R1 exits.** The largest single block is the
far-ocean/curvature family (TERR-120–126), which nothing has started.

### Owed to Ash

- The `terrainOrder` verdict: a pixel diff and a paired GPU delta, then a
  decision on whether `before` becomes the default.
- The voyage-clock approach verdict (honest 1× vs governed) from 2026-08-14,
  still open.
- Whether the haze-toward-a-cloudless-sky fault is folded into TERR-137 or
  taken separately.

Evidence: baseline JSONs are committed; captures land untracked in
`evidence/terrain/r1-renderer/` (git keeps compact JSONs only, per
`.gitignore`'s whitelist convention).
