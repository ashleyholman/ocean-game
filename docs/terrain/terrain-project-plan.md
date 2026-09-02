---
title: Drift Terrain Project Plan
status: Active
current_phase: R1 — Synthetic renderer capability spike
last_updated: 2026-08-18
design: terrain-system-design.md
research: terrain-technical-guide.md
handover: TERRAIN_ROUND_HANDOVER.md
---

# Drift Terrain Project Plan

## 1. Project outcome

Add geographically recognisable real-world land to Drift while preserving the
existing ocean quality, planetary simulation authority and supported frame
budget.

The programme begins with renderer and regional-data risk reduction. A global
terrain build is not authorised by this plan until Gate A has passed.

## 2. Status convention

Use exactly one of these values in task tables:

| Status | Meaning |
|---|---|
| `not_started` | Not yet ready or intentionally deferred |
| `ready` | Inputs and preceding gates are satisfied |
| `in_progress` | Active work |
| `blocked` | Cannot proceed; blocker must be named in Notes |
| `complete` | Acceptance evidence exists and is linked or identified |
| `dropped` | Deliberately removed with a recorded decision |

A task is not `complete` merely because code exists. Its stated evidence and
acceptance conditions must also exist.

## 3. Working rules

1. De-risk renderer viability before building a production data pipeline.
2. De-risk one real region before building a global hierarchy.
3. Record open-water performance before and after every renderer experiment.
4. Preserve the canonical WGS84/ECEF world and `WorldRenderAdapter` boundary.
5. Do not add terrain orchestration directly to the `main.ts` composition root.
6. Keep source geospatial data out of Git and out of runtime delivery.
7. Pin source versions, checksums, transformations and licences before a real
   data result is accepted.
8. Prefer reversible experimental paths until Gate A selects the production
   solution.
9. Keep visual terrain and gameplay collision authority separate.
10. Do not allow vegetation, shadows or historical detail to delay the first
    silhouette/coastline verdict.

## 4. Programme gates

| Gate | Decision | Required evidence | Status |
|---|---|---|---|
| R0 | Documentation and baseline approved | Research retained; design and plan reviewed; performance baseline recorded | `complete` |
| R1 | Renderer can support planetary terrain | Depth, curved ocean, far ocean, synthetic terrain and GPU evidence pass | `in_progress` |
| R2 | Real public data is visually worthwhile | One reproducible regional build and render matrix pass | `not_started` |
| R3 | Web delivery is viable | Measured tile sizes, requests, decode, memory, cache and throttled traversal pass | `not_started` |
| A | Authorise production global architecture | R1–R3 decisions consolidated; budgets and hierarchy selected | `not_started` |
| B | Authorise semantic materials and vegetation | Global terrain/streaming foundation is stable | `not_started` |
| C | Authorise authored ports and gameplay land collision | Coastline and local-patch contracts are stable | `not_started` |

### 4.1 Authorised coarse-global integration slice

On 2026-08-17 a separate vertical slice was authorised to connect the world
panel, globe and live terrain boundary before the production data gates. It
uses Natural Earth only in the role the research guide permits: cartographic
globe and farthest fallback data. It does not authorise R2, select Gate A's
production hierarchy, or count toward GLO-30/WBM acceptance.

| ID | Task | Status | Evidence / notes |
|---|---|---|---|
| TERR-G001 | Pin a deterministic coarse global land/relief manifest | `complete` | `src/terrain/data/global-coarse-manifest.json`; exact Natural Earth releases and archive hashes, derived-asset hash, public-domain posture and accuracy notice; `tests/global-terrain-source.test.ts` |
| TERR-G002 | Expose one provider to globe and renderer | `complete` | `GlobalTerrainSource` implements `TerrainTileProvider`; `DeveloperGlobe` and `TerrainSystem` consume the same exported source/build ID |
| TERR-G003 | Refresh local coarse tiles from canonical teleport/travel state | `complete` | `TerrainSystem.update()` derives the provider key from canonical ECEF; `tests/terrain-global-provider.test.ts` exercises a real `PlanetaryWorld` teleport |
| TERR-G004 | Prove coordinate, antimeridian, pole and globe behaviour | `complete` | `tests/global-terrain-source.test.ts` and `tests/developer-globe-terrain.test.ts`; bit-identical resident shared edges across the antimeridian and finite polar neighbourhoods |
| TERR-G005 | Supply governed voyage mode with a bounded nearest-land query | `complete` | Same decoded Natural Earth rings; fixed 5,004-segment spherical scan; land/ocean/antimeridian/pole and live governor tests |
| TERR-G006 | Resolve authored land openings and explicit-global globe selections to qualified water | `complete` | Pure bounded resolver over the shared source; explicit-global bootstrap plus player/developer globe clicks; the authored land opening, open-water identity, relocation, deep-inland rejection, antimeridian, pole gauge, tie and diagnostics tests |
| TERR-G007 | Acquire and ingest canonical GLO-30/WBM data | `not_started` | Explicitly absent. Manifest statuses are `not_acquired`; remains TERR-200/TERR-201 under the R2 gate |

The implementation record and limitations are in
`docs/terrain/global-coarse-vertical-slice.md`. P1 remains `not_started`: this
temporary 2° geographic fallback has no production cube-sphere hierarchy,
measured DEM, WBM coastline, LOD, publication or streaming system.

## 5. R0 — Documentation and baseline

### Objective

Create one agreed design, retain the dataset research separately, and establish
the measurements later phases must beat or preserve.

### Tasks

| ID | Task | Status | Evidence / notes |
|---|---|---|---|
| TERR-000 | Retain `terrain-technical-guide.md` unchanged as the research and provenance input | `complete` | `docs/terrain/terrain-technical-guide.md` is committed alongside this plan |
| TERR-001 | Write the game-specific terrain system design | `complete` | `docs/terrain/terrain-system-design.md` |
| TERR-002 | Write the separate status-tracked project plan | `complete` | This document |
| TERR-003 | Review and approve the scope, gates and deferred work | `complete` | Fable review 2026-08-05 amended both docs (cloud occlusion, reflections, depth/early-z, matrix pruning, lighting seams); Ash approved 2026-08-06 |
| TERR-004 | Capture the current open-water performance baseline | `complete` | Uncontended desktop capture `evidence/terrain/baseline/performance.json` (2026-08-06) via `?perf=terrain-baseline` (src/debug/terrainBaselineEvidence.ts); contended 2026-08-05 run retained beside it as provenance. Desktop only: the mobile/low-power tier is explicitly deferred to the R1 lower-power capture, not silently dropped |
| TERR-005 | Record camera geometry and horizon baseline | `complete` | `evidence/terrain/baseline/camera-geometry.json`. Notable measurements: embodied eye 3.4 m (not 5 m); near plane is adaptive — 0.06 m embodied, 0.25 m default cinematic, ~5.35 m at maximum altitude |
| TERR-006 | Set provisional R1 budgets | `complete` | Baseline-backed budgets in `docs/terrain/decisions/R1-budgets.md` (uncontended run; ≤1.0 ms ordinary-view increment, ≤3.0 ms maximum cinematic) |
| TERR-007 | Create terrain evidence and decision-record conventions | `complete` | `evidence/terrain/baseline/` (+`captures/`) and `docs/terrain/decisions/` exist and are in use |

### Baseline matrix

Capture at minimum:

| View | Sea state | Light | Required readings |
|---|---|---|---|
| Embodied forward | Production default | Midday | Frame, GPU passes, buffer size, near/far |
| Embodied toward low Sun | Production default | Low Sun | Same plus ocean worst-case observation |
| Default cinematic | Production default | Midday | Same |
| Default cinematic | Rough production preset | Low Sun | Same |
| Maximum cinematic | Production default | Midday | Same plus visible ocean-rim evidence |
| Maximum cinematic | Rough production preset | Low Sun | Same |

### R0 exit criteria

- [x] Research guide is present on the terrain branch as a separate document.
- [x] Design and project plan are approved (Ash, 2026-08-06).
- [x] Repeatable baseline captures and machine-readable timings exist.
- [x] R1 provisional budgets are written down.
- [x] No terrain production code has been started prematurely (the baseline
      harness and R1 spec are diagnostics and documentation).

## 6. R1 — Synthetic renderer capability spike

### Objective

Settle the expensive renderer unknowns without involving real geospatial data,
global tiling, network delivery or vegetation.

### Workstream R1-A — Anchored synthetic terrain

| ID | Task | Status | Acceptance evidence |
|---|---|---|---|
| TERR-100 | Define a minimal experimental terrain-tile interface | `complete` | `src/terrain/TerrainTile.ts`: opaque key + lattice-based geometry contract; addressing never reaches the renderer. Lattice fields documented as experimental, replaceable at Gate A |
| TERR-101 | Generate deterministic synthetic island and mountain fixtures | `complete` | `src/terrain/syntheticFixtures.ts` + `tests/terrain-fixtures.test.ts`: four spec fixtures, bit-identical regeneration, exact shared edges, −60 m underwater continuation, spec peak heights |
| TERR-102 | Add a tile-anchor ECEF-to-render transform to the existing render boundary | `complete` | `WorldRenderAdapter.anchoredTileMatrix` + `src/terrain/terrainMath.ts` + `tests/terrain-anchored-transform.test.ts`: <1 mm at 5 km, <5 cm at 300 km, at equator/the authored land opening/antimeridian/80°S and under rotated transported frames |
| TERR-103 | Render static Float32 tile-local geometry from double-precision ECEF anchors | `in_progress` | Render path works: `TerrainSystem`/`TerrainTileMesh` + `?terrain=synthetic&fixture=&range=&bearing=` harness; fixtures render anchored with curvature sag (−3 m at 6 km observed), lattice normals verified, two-way ocean/terrain occlusion correct at 2.5–10 km. Long-range jitter matrix (80–300 km) remains. The apparent 6–10 km z-fight fringe was later proven mode-independent shoreline content; see DEPTH-01 and the depth decision record |
| TERR-104 | Exercise accelerated vessel travel past and across synthetic tile boundaries | `complete` | `tests/terrain-accelerated-travel.test.ts`: the real geodesic integrator at 30x on a 16 km track past `mountain`, crossing all four tile-column boundaries. Over 10,670 frames — worst seam 1.25e-4 m, worst reconstruction 5.46e-5 m, worst jerk 3.57e-7 m and 3.56e-7 m within 50 m of a boundary (i.e. crossing one is not an event); 30 s at 1x equals 1 s at 30x to 1.29e-6 m; 120 frames equals 1,200 substeps to 8.38e-7 m; the anchored matrix is bit-identical under changed clock, rate, pause and velocity. Found and fixed: the live clearance readout over-reported by up to 5.07 km once the vessel left the placement bearing |

### Workstream R1-B — Camera and depth

| ID | Task | Status | Acceptance evidence |
|---|---|---|---|
| TERR-110 | Add an experimental long-range camera mode without changing production camera limits | `complete` | `&far=<km>` on the terrain harness raises the far plane (pose updates never touch far); absent the parameter the production 25 km limit is untouched. Verified: peak fixture rendered from 120 km through a 200 km far plane |
| TERR-111 | Test conventional depth to at least 300 km | `in_progress` | Quiet-GPU control complete; 6 km cinematic/embodied image and motion checks show DEPTH-01's dashes are mode-independent shoreline content. Conventional remains unsuitable by 20–300 km precision arithmetic; the explicit 80–300 km moving/jitter capture remains with TERR-103/104 |
| TERR-112 | Test logarithmic depth | `complete` | Image-correct including ocean TAA; paired 21 km peak increment 1.223 ± 0.102 ms SE, 0.651 ± 0.121 ms above reversed-Z and over the 1.0 ms ordinary-view budget. `gl_FragDepth` compatibility path retained but not budget-clean; evidence and profiler accounting limit in `docs/terrain/decisions/depth-candidates.md` |
| TERR-113 | Test reversed depth where supported | `complete` | `EXT_clip_control=true`, reversed mode active on Apple M2/Chrome 151; image-correct and no systematic open-water tax; paired peak increment 0.572 ± 0.065 ms SE. Fullscreen-camera fixes and three r185 render-list workaround documented in the decision record |
| TERR-114 | Prototype two-range rendering only if simpler options fail | `not_started` | Correct compositing of vessel, ocean, near coast and distant terrain |
| TERR-115 | Select and document the R1 depth verdict | `in_progress` | Desktop verdict recorded: reversed-Z preferred, log fallback, conventional control. Close after 80–300 km moving/jitter validation and the deferred lower-power/browser capability check |

### Workstream R1-C — Curved and far ocean

| ID | Task | Status | Acceptance evidence |
|---|---|---|---|
| TERR-120 | Add spherical presentation curvature to the detailed ocean experiment | `not_started` | Correct 20 km sag; vessel/buoyancy registration unchanged near origin |
| TERR-121 | Apply curvature consistently to production, temporal metadata and relevant depth/shadow variants | `not_started` | TAA on/off parity; no history mask or depth disagreement |
| TERR-122 | Prototype a WGS84 local-curvature refinement | `not_started` | Compare against spherical form through far-ocean range; retain only if visibly or numerically material |
| TERR-123 | Build a cheap curved far-ocean annulus | `not_started` | Covers maximum-camera sea horizon without a false rim |
| TERR-124 | Compare zero, four and eight long-wave far-ocean variants | `not_started` | Still/motion sheets and GPU A/B timings |
| TERR-125 | Crossfade detailed and far ocean | `not_started` | No visible ring in calm, moderate and rough sea under slow camera motion |
| TERR-126 | Prove embodied/default views do not materially pay for hidden far ocean | `not_started` | Direct GPU comparison against R0 baseline |

### Workstream R1-D — Terrain/ocean image and performance

| ID | Task | Status | Acceptance evidence |
|---|---|---|---|
| TERR-130 | Give the synthetic island an underwater continuation | `complete` | The wall was already handled; the GAP was not. `low-coast` stood 354 outer-ring samples up to 11.6 m above the sea — a sheet ending in mid-air, invisible to the `min(height) <= -50` check. `FIXTURE_RIM_MARGIN_M` drowns every fixture's rim; `tests/terrain-fixtures.test.ts` measures the boundary ring and the waterline slope separately |
| TERR-131 | Establish terrain-before-ocean depth ordering where beneficial | `in_progress` | Mechanism built, default unchanged. Terrain and the sea shared `renderOrder` 0 and three broke the tie by projected origin depth, so the sea drew FIRST and shaded every fragment hidden behind land. Both arms are now explicit (`src/terrain/terrainDrawOrder.ts`), live, and registered as the `terrainOrder` A/B switch; `after` (what shipped) is the default. "Where beneficial" needs a quiet-GPU paired delta and a pixel diff at the waterline — the depth function is LESS, so a tie changes hands with the flip |
| TERR-132 | Add simple slope lighting through the world lighting path | `complete` | Already satisfied by TERR-103's construction and now measured rather than assumed. Terrain builds on `createWorldPbrMaterial`, so Sun, Moon, sky probe and exposure arrive by the hull's path, and normals are real slope normals across the fixture-wide lattice. `tests/terrain-tile-mesh.test.ts` checks them against the mesh's own triangles (worst 6°, all up) and pins bit-identical normals on both sides of every shared edge. The PALETTE remains scaffolding for R2 materials; the lighting never was |
| TERR-133 | Add temporary constant-controlled atmospheric haze | `in_progress` | Terrain hazes toward the same sky-radiance LUT as the ocean, mixed in linear HDR before the shared tone transform; `&haze=<km>` is the visibility-distance input (design §8.2). Stills verified at 6 km and 120 km. Stability half CLOSED: the LUT mapping was duplicated by hand in `Ocean.ts` and `TerrainSystem.ts`, where a one-texel-row divergence would read as a seam at the waterline that MOVES as the vessel turns; now one `GLSL_SKY_RADIANCE_LUT_UV`, enforced by `tests/shader-source.test.ts`. Explicit synthetic `?haze=` is also reapplied after weather/environment derivation for named capture and motion diagnostics; sessions without it retain ordinary weather visibility. The 20–300 km sweep still needs a quiet GPU. Recorded fault: the haze mixes toward a CLOUDLESS sky while the pixel behind distant land is sky plus clouds |
| TERR-134 | Add terrain/far-ocean profiler buckets and runtime counts | `in_progress` | Built, deliberately not run (thermally throttled machine). `sceneOpaque`, `terrain` and `ocean` are now three buckets where the `ocean` prefix previously contained the vessel AND terrain; the terrain bucket is terrain-only in both `terrainOrder` arms and reads about zero with `?terrain=off` instead of stalling the rotation. Counts: tiles, triangles, vertices and resident geometry bytes on `TerrainSystem.stats`, in the depth evidence and the Terrain panel. Two consequences: a rotation is 8 frames not 6 (read `framesPerRotation`), and every pre-split evidence file has the ship inside its `ocean` figure |
| TERR-135 | Capture the canonical synthetic render set | `in_progress` | Camera seam, canonical table, deterministic CLI plan and motion checklists are complete. `src/debug/terrainCanonicalViews.ts` owns 12 bounded rows: 10 still recipes (two A/B, yielding 12 atomic PNGs) plus slow-orbit and fixed-30× travel eye checks. It covers 1/5/20/80/200/300 km, embodied/authored/maximum cinematic, calm/rough, low/midday light, TAA, and fixed desktop/mobile tiers. `tools/terrain-canonical-captures.mjs` reuses the established capture host, asserts cold-machine/new-output/open-gate policy, and records actual mode/scale/tier metadata. Browser-free plan/tests ran; the cold pixel run and human still/motion verdict remain, so no visual acceptance is claimed |
| TERR-136 | Write R1 verdict and recommended production candidates | `not_started` | Depth, ocean split, cloud occlusion, range and budget decisions are explicit |
| TERR-137 | Test cloud/terrain occlusion | `not_started` | Synthetic 3,000 m peak with the cloud field in front of and behind it, plus the horizon cloud band case; occlusion mechanism, GPU cost and temporal cloud-cache interaction recorded (design §8.3) |

### R1 render matrix

Synthetic fixtures are viewed at approximately 1, 5, 20, 80 and 200 km, plus
a 300 km clipping/bounds case. The relevant dimensions are:

- embodied, default cinematic and maximum cinematic where geometrically valid;
- midday and low-angle Sun;
- calm and rough sea;
- stationary and slow camera orbit;
- stationary and accelerated vessel travel;
- OceanTemporalResolve enabled and disabled;
- production resolution plus a fixed lower-power tier.

These dimensions MUST NOT be captured as a full cross-product. Taken
literally that is over a thousand captures, and the verdict would drown in
bookkeeping. Instead:

- define a named canonical set of roughly twelve views that together exercise
  every dimension at least once and each high-risk pairing exactly once
  (low Sun plus rough sea at the coastline; temporal resolve on/off at one
  identical view; maximum cinematic over the far ocean; the cloud-occlusion
  peak case);
- capture the canonical set repeatably as the regression and evidence record;
- add targeted captures only where a specific finding needs them;
- treat a live eye pass through the canonical views as the primary verdict,
  with the captures as its durable record.

### R1 exit criteria

- [ ] One depth strategy works across the 6 cm near plane and long terrain range.
- [ ] Detailed ocean curvature agrees across all passes.
- [ ] Maximum cinematic view has a correct curved sea horizon.
- [ ] Detailed/far-ocean transition is not visible in stills or motion.
- [ ] Synthetic land intersects ocean without drowning, a wall or a gap.
- [ ] Cloud/terrain occlusion has a chosen mechanism with no punch-through in
      either direction.
- [ ] ECEF-anchored geometry remains stable during accelerated travel.
- [ ] Ordinary embodied/default views remain within the R1 budget.
- [ ] Maximum cinematic incremental cost is measured and accepted.
- [ ] No unresolved renderer issue makes a real-data spike wasteful.

## 7. R2 — Regional real-data spike

### Objective

Determine whether canonical public elevation and water data can produce
recognisable, attractive Drift land at the actual viewing distances.

### Proposed area

Start with Kangaroo Island plus an adjacent Fleurieu Peninsula coastal window.
It is locally recognisable and exercises islands, headlands, beaches, cliffs
and moderately varied relief. If a decisive high-mountain verdict is still
needed, add one very small Fiordland or Tahiti fixture; do not expand to the
four-region research matrix yet.

### Workstream R2-A — Reproducible input

| ID | Task | Status | Acceptance evidence |
|---|---|---|---|
| TERR-200 | Pin exact Copernicus DEM and Water Body Mask releases | `not_started` | Source manifest, terms snapshot, URLs and checksums |
| TERR-201 | Acquire only the AOI source tiles | `not_started` | Clean acquisition command and verified cache |
| TERR-202 | Establish isolated GDAL/PROJ or equivalent tool versions | `not_started` | Reproducible tool manifest; no runtime dependency added to the game bundle |
| TERR-203 | Validate CRS, axes, vertical units, nodata and WBM classes | `not_started` | Automated fixture checks and human-readable report |

### Workstream R2-B — Minimal build

| ID | Task | Status | Acceptance evidence |
|---|---|---|---|
| TERR-210 | Sample AOI elevation and water class into the provisional tile interface | `not_started` | Deterministic tile checksums from a clean cache |
| TERR-211 | Generate three extrema-aware height LODs | `not_started` | Parent error metadata and preserved coastline/high points |
| TERR-212 | Reproduce shared edges and neighbour metadata | `not_started` | Bit-identical same-LOD borders; no geometric cracks and no lighting seams — normals continuous across tile edges |
| TERR-213 | Derive a first coastal underwater band | `not_started` | Ocean intersection remains continuous around test shoreline |
| TERR-214 | Quantise height and record error | `not_started` | Maximum decode error is below the chosen LOD tolerance |
| TERR-215 | Preserve selected small islands/components | `not_started` | Named test components survive required parent LODs |

### Workstream R2-C — Runtime and visual verdict

| ID | Task | Status | Acceptance evidence |
|---|---|---|---|
| TERR-220 | Load a static regional tile pack through `TerrainSystem` | `not_started` | No bespoke scene placement outside the terrain boundary |
| TERR-221 | Add basic elevation/slope/coast material synthesis | `not_started` | Rock/soil/vegetation-mass response without WorldCover dependency |
| TERR-222 | Optionally add one WorldCover comparison | `not_started` | Separate A/B; does not block primary height/coast verdict |
| TERR-223 | Implement three-LOD selection, neighbour constraint and morph | `not_started` | No crack, pulse, lighting seam at tile borders or silhouette collapse in motion |
| TERR-224 | Capture real-region matrix at 1, 5, 20 and 80 km | `not_started` | Midday, low Sun, clear and hazy variants |
| TERR-225 | Record CPU, GPU, payload and resident-memory readings | `not_started` | Direct comparison with R0 and R1 baselines |
| TERR-226 | Conduct recognisability and coastline review | `not_started` | Explicit pass/fail findings, not an unrecorded visual impression; absent land reflections in water are judged as the recorded accepted limitation (design §6.6), not as a terrain defect |
| TERR-227 | Write R2 verdict | `not_started` | Data-resolution, material and local-authoring limits stated |

### R2 exit criteria

- [ ] AOI build is deterministic and fully provenance-traced.
- [ ] Land is correctly anchored on WGS84 and recognisable at intended ranges.
- [ ] Coastline follows the canonical WBM without gross mismatch.
- [ ] Three LODs transition without cracks, peak collapse or island loss.
- [ ] Basic lighting and haze make the terrain belong to the existing world.
- [ ] GPU and resident-memory cost fit the provisional regional budget.
- [ ] Limitations below roughly 1 km are understood and accepted.
- [ ] The result justifies investment in delivery infrastructure.

## 8. R3 — Tile delivery and cache spike

### Objective

Prove that a web player can obtain only nearby derived terrain without stalls,
unbounded memory or a whole-world download.

### Tasks

| ID | Task | Status | Acceptance evidence |
|---|---|---|---|
| TERR-300 | Freeze experimental binary tile schema v0 | `not_started` | Versioned decoder tests and schema document |
| TERR-301 | Measure compression candidates on the R2 pack | `not_started` | Size, decode time and precision comparison |
| TERR-302 | Publish immutable local/CDN-shaped URLs and manifest | `not_started` | Versioned path and content-integrity checks |
| TERR-303 | Add request deduplication, priority and cancellation | `not_started` | No duplicate fetch; obsolete camera work is cancelled |
| TERR-304 | Decode tiles in Web Workers | `not_started` | Main-thread decode budget under load is met |
| TERR-305 | Add bounded GPU resident-tile LRU | `not_started` | Eviction and resource disposal tests |
| TERR-306 | Add bounded browser disk cache | `not_started` | Version isolation, eviction and warm-start evidence |
| TERR-307 | Add coarse fallback during missing child fetches | `not_started` | No terrain hole during cold traversal |
| TERR-308 | Test current 30x voyage traversal and route-ahead prefetch | `not_started` | No late visible tiles at representative speed and latency |
| TERR-309 | Test cold, warm, offline, throttled and failed requests | `not_started` | Behaviour and recovery documented for each case |
| TERR-310 | Extrapolate sparse global storage and voyage egress | `not_started` | Based on measured tile populations and payloads, not uniform raw resolution |
| TERR-311 | Write R3 verdict | `not_started` | Selected transport/cache candidates and remaining risks |

### R3 exit criteria

- [ ] Browser never downloads the raw source dataset.
- [ ] Only manifest, coarse fallback and relevant regional tiles are requested.
- [ ] Main-thread frame cadence remains stable during fetch and decode.
- [ ] GPU and disk caches remain inside recorded bounds.
- [ ] Cold traversal retains a coarse surface until children arrive.
- [ ] Warm traversal does not refetch unchanged immutable tiles.
- [ ] Accelerated voyage prefetch avoids visible holes under agreed latency.
- [ ] Global server storage and representative CDN egress have an evidence-based estimate.

## 9. Gate A — Production architecture decision

Gate A is a review, not an implementation task. It consolidates R1–R3 and
records one decision for each row:

| Decision | Candidates | Status |
|---|---|---|
| Camera depth | Conventional, logarithmic, reversed, two-range | `R1 desktop candidate: reversed-Z; log fallback; Gate A pending` |
| Terrain far visibility | Geometry-only maximum plus weather/art cap | `not_started` |
| Ocean structure | Extended detailed disc versus detailed disc + cheap annulus | `not_started` |
| Far-ocean wave subset | Zero, four, eight, measured alternative | `not_started` |
| Globe hierarchy | Cube-sphere quadtree versus measured alternative | `not_started` |
| Tile sample grid | 129, 257, measured alternative | `not_started` |
| Height and class encoding | R2/R3 measured candidates | `not_started` |
| Runtime packaging | Individual tiles, regional packs, range-addressed bundle | `not_started` |
| Browser cache | HTTP only, Cache Storage, IndexedDB, hybrid | `not_started` |
| Global coverage | Coarse global + coastal tiers + hero packs | `not_started` |
| Initial regions | South Australia, intended voyage regions, selected additions | `not_started` |

Gate A passes only when the selected set fits together. Individually successful
experiments are insufficient if their combined renderer or delivery design is
inconsistent.

## 10. Production milestones after Gate A

These milestones are deliberately high level until the spikes select concrete
technology and budgets.

### P1 — Global terrain foundation

- production cube-sphere/equivalent builder;
- global coarse terrain;
- coastal and highland sparse tiers;
- extrema and protected-island catalogue;
- deterministic versioned publication;
- global edge, pole and antimeridian tests.

Status: `not_started`

### P2 — Coastline and terrain materials

- coast signed-distance field;
- stable ocean clipping;
- rock, soil, sand, wetland, grass and snow weights;
- slope, aspect, curvature and local relief;
- improved atmospheric perspective;
- terrain self-shadow candidate and decision.

Status: `not_started`

### P3 — Production streaming

- project-controlled object storage/CDN;
- route/camera prefetch;
- disk and GPU cache telemetry;
- schema migration and immutable build selection;
- offline/coarse fallback profile.

Status: `not_started`

### P4 — Regional identity and vegetation

- ecoregion palettes;
- far canopy mass;
- deterministic clustered near vegetation;
- separate vegetation LOD;
- optional fractional cover and canopy-height evaluation.

Status: `not_started`

### P5 — Local authored patches

- geodetic patch schema;
- elevation, water, bathymetry and vegetation overrides;
- one complete port;
- one atoll/reef case;
- seam blending and deterministic priority.

Status: `not_started`

### P6 — Land blocking and later navigation

- CPU `TerrainWorldQuery`;
- segment versus non-navigable-land query;
- stop vessel before land;
- water-aware initial spawn;
- later grounding and bathymetry only if separately authorised.

Status: `not_started`

### P7 — Historical periodisation

- suppress modern built-up land;
- replace implausible modern agriculture;
- flag reservoirs and reclaimed shore;
- author historical settlements at story locations.

Status: `not_started`

### P8 — World build and regression

- complete selected coverage build;
- checksum and provenance validation;
- canonical visual matrices;
- protected land/channel tests;
- target-device CPU/GPU/IO/network qualification;
- freeze immutable terrain build v1.

Status: `not_started`

## 11. Risk register

| Risk | Description | Initial severity | Reduction phase | Status |
|---|---|---:|---|---|
| DEPTH-01 | 6 cm near plane and 250–300 km terrain cannot share adequate precision | Critical | R1 | Reduced — 6–10 km dashes were shoreline content, not z-fighting; reversed-Z selected and measured on desktop, with 80–300 km moving validation and fallback-platform qualification still open |
| OCEAN-01 | Flat 20 km ocean creates false horizon and obscures curved coast | Critical | R1 | Open |
| OCEAN-02 | Detailed/far-ocean seam becomes visible in motion | High | R1 | Open |
| PERF-01 | Terrain plus far water exceeds an already ocean-heavy GPU budget | Critical | R0/R1 | Open |
| COORD-01 | ECEF tile anchors jitter or drift under transported-frame movement | High | R1 | Open |
| TAA-01 | Terrain/depth changes invalidate ocean temporal metadata or occlusion | High | R1 | Open |
| CLOUD-01 | Cloud volume composites without scene depth; terrain and clouds cannot occlude each other, and the horizon cloud band sits where distant peaks appear | High | R1 | Open |
| REFLECT-01 | Ocean reflections sample only sky and clouds; nearshore water does not mirror land | Medium for first result | P2 | Accepted deferral |
| DATA-01 | 30 m DSM does not look convincing at intended distances | Critical | R2 | Open |
| COAST-01 | WBM and elevation produce unstable or implausible water intersection | High | R2 | Open |
| LOD-01 | Coarse tiles suppress peaks or remove islands | High | R2 | Open |
| IO-01 | Tile request/decode churn creates visible holes or frame stalls | High | R3 | Open |
| SIZE-01 | Sparse global derived hierarchy remains too large or costly | High | R3 | Open |
| GLOBAL-01 | Face, pole or antimeridian seams fail | High | Post-R2/Gate A | Open |
| LICENCE-01 | Source terms or attribution are incomplete | Critical | R2 and every source upgrade | Open |
| SHADOW-01 | Terrain lacks convincing large-scale self-shadow | Medium for first result | P2 | Accepted deferral |
| GAMEPLAY-01 | Ship can visually sail through land | Medium for first result | P6 | Accepted deferral |
| HISTORY-01 | Modern land cover conflicts with game period | Medium for first result | P7 | Accepted deferral |

## 12. Decision log

| ID | Date | Decision | Status |
|---|---|---|---|
| TD-001 | 2026-08-05 | Keep the dataset research guide as a separate document rather than rewriting it into the game design | Accepted for review |
| TD-002 | 2026-08-05 | Maintain separate terrain system design and project-status documents | Accepted for review |
| TD-003 | 2026-08-05 | Run a synthetic renderer spike before a real-data pipeline | Accepted for review |
| TD-004 | 2026-08-05 | Run a single-region real-data spike before global generation | Accepted for review |
| TD-005 | 2026-08-05 | Runtime receives compact derived tiles; raw geospatial products remain offline | Accepted for review |
| TD-006 | 2026-08-05 | Do not reduce maximum cinematic zoom solely to simplify terrain before measuring it | Proposed |
| TD-007 | 2026-08-05 | Defer general teleport handling and full collision; add simple land blocking after visual terrain | Partially superseded: explicit-global globe clicks are water-qualified; collision remains deferred |
| TD-008 | 2026-08-05 | Use basic slope lighting and crude configurable haze for the first regional verdict | Proposed |
| TD-013 | 2026-08-05 | Record land-free ocean reflections as an accepted limitation of the first regional result | Proposed |
| TD-014 | 2026-08-05 | Capture a named canonical render set rather than the full render-matrix cross-product; the live eye pass is the primary verdict | Proposed |
| TD-009 | — | Select camera depth strategy | Pending R1 |
| TD-010 | — | Select detailed/far-ocean structure | Pending R1 |
| TD-011 | — | Select production globe hierarchy and tile size | Pending Gate A |
| TD-012 | — | Select terrain self-shadow strategy | Pending P2 |
| TD-015 | — | Select cloud/terrain occlusion mechanism | Pending R1 |

## 13. Evidence layout

Proposed committed evidence structure:

```text
evidence/terrain/
  baseline/
    performance.json
    camera-geometry.json
    captures/
  r1-renderer/
    depth/
    ocean-curvature/
    far-ocean/
    ecef-stability/
    performance/
  r2-regional/
    manifests/
    build-report.json
    captures/
    performance/
  r3-delivery/
    payloads.json
    network-runs.json
    cache-runs.json

docs/terrain/decisions/
  TD-009-depth-strategy.md
  TD-010-ocean-structure.md
  TD-011-production-hierarchy.md
```

Large generated terrain tiles and source rasters remain outside Git. Small,
licence-compatible deterministic fixtures may be committed under a dedicated
test-fixture directory after provenance review.

## 14. Immediate queue

Updated 2026-08-18. R0 is complete. R1-A (TERR-100–103), the long-range far
plane (TERR-110) and the depth candidates (TERR-111–113) are landed. The
2026-08-16/17 code round closed TERR-104, TERR-130, TERR-132 and TERR-133's
stability half, built TERR-131's mechanism and TERR-134's buckets without
running either. TERR-135 now has its camera seam, canonical table, deterministic
CLI plan and motion checklists; its cold pixels and eye verdict remain.
The separately authorised TERR-G001–G006 coarse-global work is landed and
tested; it changes none of the R1/R2/Gate A statuses above. Canonical ingestion
(TERR-G007) remains explicitly `not_started`.
`docs/terrain/TERRAIN_ROUND_HANDOVER.md` carries the whole record, the traps
already paid for, and a runbook for every measurement below. In order:

1. **Cold-machine measurement pass.** Nothing here is new code; it is running
   instruments that already exist, and it unblocks four exit criteria at once:
   the terrain/vessel/ocean profiler buckets (TERR-134); the `terrainOrder`
   A/B — pixel diff at the waterline plus a paired GPU delta, which is the
   whole of TERR-131's "where beneficial"; the 80–300 km jitter/depth matrix
   via `&far` (TERR-103/111, the desktop part of TERR-115); and TERR-133's
   20–300 km haze sweep. **Every pre-split evidence file has the vessel inside
   its `ocean` figure and is not comparable to a post-split one.**
2. **TERR-135**, the canonical 12-row review set. The table and capture command
   are ready; run its 12 atomic still frames on a cold machine with
   `node tools/terrain-canonical-captures.mjs --capture --cold-machine --out
   evidence/terrain/r1-renderer/terr-135-canonical-cold`, then execute the two
   named live motion checklists and record the eye verdict. Do not treat the
   cloud/peak staging row as TERR-137 acceptance.
3. Qualify reversed-Z capability and the over-budget log fallback on the
   deferred lower-power/browser tier.
4. TERR-137: cloud/terrain occlusion. The terrain haze's cloudless-sky
   mismatch is the same family and should be settled with it.
5. TERR-120 onward: ocean curvature and the far-ocean split, using the
   selected reversed-Z desktop path. This family is the largest single block
   remaining before R1 can exit, and nothing has started it.

This ordering keeps the renderer verdict cheap and reversible before any
expensive global data work. **R2 is not authorised until R1 exits** (§6).
