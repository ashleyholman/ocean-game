---
title: Drift Terrain and Land Rendering System Design
status: Proposed
last_updated: 2026-08-05
related_research: terrain-technical-guide.md
related_plan: terrain-project-plan.md
---

# Drift Terrain and Land Rendering System Design

## 1. Decision summary

Drift should add real-world land as a new streamed planetary rendering system.
The existing WGS84/ECEF world model and vessel-centred render frame should be
preserved. They are the correct foundation for geographically anchored terrain
and remove the need for an Earth-coordinate rewrite.

The implementation should proceed through deliberately small risk-reduction
spikes before a global data build:

1. prove long-range depth, curved-ocean and terrain/ocean rendering with
   synthetic land;
2. prove the visual value of real elevation and water-mask data in one small
   region;
3. measure representative tile payload, streaming, decoding, memory and cache
   behaviour;
4. only then choose and build the production global hierarchy;
5. add semantic materials, vegetation and authored locations after the terrain
   foundation is stable.

The research guide remains useful and should be retained unchanged as the
dataset, licensing and offline-processing reference. This document owns the
game-specific renderer, runtime, integration and delivery design. The separate
project plan owns task status and gates. The guide's suggested repository
layout (its §25) is superseded by this design's module layout and the project
plan's evidence layout; the guide remains authoritative for datasets,
licensing and offline processing only.

## 2. Scope of the first useful result

The first useful result is intentionally narrower than the complete research
guide:

- place the vessel near a selected real coastline;
- render the real shape and elevation of that land in the correct planetary
  position;
- preserve recognisable island, headland and mountain silhouettes;
- make the ocean meet the coastline without an obvious wall or gap;
- remain stable while the vessel moves through the existing accelerated
  planetary voyage;
- look credible in embodied, default cinematic and maximum cinematic views;
- remain within an explicitly measured performance budget.

The first result does not require:

- global vegetation;
- terrain self-shadowing beyond ordinary slope lighting;
- authored ports, structures or reefs;
- historical land-cover reconstruction;
- navigational bathymetry;
- grounding physics;
- land-aware teleportation;
- a complete global high-resolution dataset;
- land reflected in the ocean surface (an accepted limitation; see §6.6).

Land blocking vessel travel is required eventually, but it belongs to a
CPU-side world-surface query built on the same canonical water data. It is not
a prerequisite for proving the visual terrain system.

## 3. Viewing range clarified

### 3.1 What the 300 km number means

A 300 km camera far plane does not mean ordinary coast should be visible from a
ship at 300 km, and it does not require moving the camera to extreme altitude.
It is a conservative clipping range that permits very high terrain to remain
visible when geometry says it can be visible.

For Earth radius `R`, observer height `h`, and terrain height `H`, approximate
line-of-sight separation is:

```text
observer horizon = sqrt(2 R h)
terrain horizon  = sqrt(2 R H)
maximum separation ~= observer horizon + terrain horizon
```

Representative geometric distances, before haze, refraction and intervening
terrain, are:

| Height | Own horizon distance |
|---:|---:|
| 3.4 m embodied observer (measured, one calm frame — not an envelope) | about 6.5 km |
| 15 m embodied planning envelope (big swell, pitch, larger future ships) | about 14 km |
| 8.6 m default cinematic camera (measured) | about 10.5 km |
| 267 m current maximum cinematic camera | about 58 km |
| 100 m headland | about 36 km |
| 500 m mountain | about 80 km |
| 1,000 m mountain | about 113 km |
| 3,000 m mountain | about 196 km |

Consequently:

- low coastline is usually a roughly 10–20 km visual concern from the ship;
- a 500 m mountain can remain geometrically visible around 90 km from the
  default cinematic view;
- a 3,000 m summit can remain geometrically visible around 205 km from the
  default view and around 254 km from the current maximum cinematic view;
- 300 km is useful headroom for rare tall terrain and conservative bounds, not
  a proposed high-detail radius.

The embodied height is not a constant: swell lifts the whole vessel, pitch
raises the head further, and larger future vessels raise the deck itself.
Planning uses the 15 m envelope; runtime selection and horizon culling MUST
use the live camera height each frame rather than any constant from this
table.

Atmospheric haze will often make the practical visual range much shorter.
Weather may eventually set a visibility limit below the geometric limit.

### 3.2 What is actually loaded and drawn

The terrain system must not treat the far plane as a request for a 300 km
circle of 30 m terrain. Selection is based on screen-space geometric error,
frustum intersection, horizon visibility and each tile's maximum elevation.

A useful starting policy is:

| Role | Approximate range | Representation |
|---|---:|---|
| Near coast | 0–20 km | Finest available regional height and coastline data |
| Regional land | 20–80 km | Reduced height grid and material detail |
| Distant high land | 80–250 km | Very coarse silhouette terrain or protected peaks |
| Beyond visibility | Variable | Culled by geometry, weather or an art-directed cap |

Most low, distant land will be rejected by horizon culling even when it lies
inside the camera frustum. A far clip distance by itself has almost no runtime
cost; submitted geometry, shaded pixels, tile IO and memory are what cost.

### 3.3 Maximum cinematic zoom

Reducing the maximum cinematic height would reduce the open-sea horizon and
the number of medium-range tiles visible at once. For example, reducing camera
height from roughly 267 m to 100 m changes the sea horizon from about 58 km to
36 km.

It does not remove the need for long-range high-terrain support: a 3,000 m
summit could still be visible more than 230 km away. It also changes an existing
camera composition for an implementation convenience that may prove
unnecessary.

Therefore the terrain project should not change the camera range up front.
The renderer spike will measure the current maximum view. A later camera-limit
decision should be an art and gameplay decision informed by those measurements.

## 4. Current architecture assessment

### 4.1 Foundations to preserve

The current system already provides:

- canonical WGS84 ECEF vessel position;
- WGS84 geodetic/ECEF conversion and geodetic surface normals;
- ellipsoidal geodesic movement through poles and the antimeridian;
- a transported tangent frame carried with the vessel;
- a vessel-centred Three.js scene that avoids large GPU coordinates;
- one explicit ECEF-to-render boundary in `WorldRenderAdapter`;
- real astronomical Sun and Moon directions;
- a shared PBR world-lighting path;
- deterministic diagnostics, capture tooling and CPU/GPU profiling.

These are strong terrain prerequisites. Terrain must consume this authority and
must not create a second latitude/longitude, floating-origin or time model.

### 4.2 Missing systems

The production terrain programme currently has no:

- terrain tile address space or hierarchy;
- terrain dataset manifest or binary tile format;
- offline geospatial build toolchain;
- runtime tile selector, requester, cache or decoder;
- terrain material and coastline representation;
- curved mean ocean surface;
- long-range camera depth policy;
- terrain atmospheric perspective;
- terrain self-shadow solution;
- cloud/terrain depth occlusion — the marched cloud volume composites as sky
  with depth testing disabled and no knowledge of scene geometry;
- terrain-aware ocean reflections — the ocean reflection path samples only
  sky and clouds;
- CPU-side canonical land/water query.

These should be added as bounded systems. Terrain orchestration should not be
added directly to the already-large `main.ts` frame sequence.

An authorised 2026-08-17 integration slice now provides a deliberately
temporary exception for the first three bullets: a Natural Earth coarse
manifest, a location-addressed `TerrainTileProvider`, and a 2° geographic
preview selector behind `TerrainSystem`. It exists to connect the globe and a
teleported canonical world position to one source. It is not the production
address hierarchy, binary format, store, decoder or gameplay
`TerrainWorldQuery`; see `global-coarse-vertical-slice.md`.

## 5. Coordinate and mesh architecture

### 5.1 Canonical representation

Every output terrain sample is geodetically anchored. Offline processing maps
the tile sample to latitude/longitude, computes the WGS84 height-zero surface
point, and displaces it along the geodetic normal by game terrain height.

Runtime rendering uses:

- one double-precision ECEF anchor per tile;
- one double-precision local basis per tile;
- compact Float32 vertex offsets relative to that tile anchor;
- one per-frame tile transform from the tile basis into the vessel's current
  transported render frame.

This keeps static geometry small and precise. Moving the vessel updates tile
matrices rather than rebuilding vertices. ECEF subtraction remains CPU-side in
JavaScript `number` precision; six-million-metre absolute positions are never
uploaded as Float32 vertex positions.

`WorldRenderAdapter` should gain an anchored-transform operation rather than
terrain implementing a second projection path.

### 5.2 Tile hierarchy

The production hierarchy is expected to be a sparse cube-sphere quadtree, as
recommended by the research guide, but this choice is not required to test the
renderer.

The synthetic and regional spikes should use a tile interface that does not
expose a geographic-quadtree assumption to rendering code. The production
addressing choice is made only after the renderer and real-data value are
proven. A later dedicated seam test must cover cube-face boundaries, the
antimeridian and high latitudes.

Tile grids should use `2^n + 1` edge samples and support:

- reproducible shared edges;
- edge-continuous normals, so lighting does not seam where geometry does not
  crack;
- parent-child height morphing;
- neighbour LOD constraints;
- geometric-error metadata;
- min/max elevation bounds;
- land fraction and water class;
- protected-island and protected-peak metadata;
- horizon and frustum culling.

### 5.3 Runtime module boundary

A likely runtime layout is:

```text
src/terrain/
  TerrainSystem.ts          orchestration boundary used by the frame runtime
  TerrainDataset.ts         manifest, schema and immutable build identity
  TerrainTileKey.ts         address-space-independent tile identity
  TerrainTileSelector.ts    screen error, neighbour, horizon and frustum rules
  TerrainTileStore.ts       request, cache, deduplication and cancellation
  TerrainTileDecoder.ts     worker-facing binary decode contract
  TerrainTileMesh.ts        GPU resource and anchored transform
  TerrainMaterial.ts        materials, haze and coastline inputs
  TerrainWorldQuery.ts      later CPU land/water and height queries
  terrainMath.ts            pure bounds, error and horizon calculations
```

`TerrainSystem.update()` should receive a read-only canonical world state,
camera information and presentation lighting. It must not advance world time or
move the vessel.

The interim global provider follows this boundary: `TerrainSystem.update()`
derives its location key from canonical ECEF and asks the provider for new
geometry only when that key changes. Provider addressing remains opaque to the
system, so Gate A can replace the temporary geographic lattice with a
cube-sphere source without changing the mesh/render contract.

## 6. Ocean integration

### 6.1 Current limitation

The current ocean is a flat observer-centred disc with a 20 km radius. At
distance `r`, a tangent plane sits approximately `r^2 / (2R)` above a spherical
Earth surface:

| Distance | Approximate flat-plane error |
|---:|---:|
| 20 km | 31 m |
| 50 km | 196 m |
| 100 km | 785 m |

Without curvature, the ocean would obscure real coastline and produce a false
horizon. This must be addressed in the first renderer spike.

### 6.2 Curvature cost

Adding curvature is cheap arithmetic. A spherical first pass is a quadratic
vertical displacement per vertex; a refined WGS84 version uses the local
meridional and prime-vertical curvature radii. It does not require increasing
the current vertex count.

The cost risk is not the curvature formula. Correctness requires applying the
same curvature convention to all relevant ocean passes, including production
geometry, temporal motion metadata and any displaced shadow/depth variant.

The CPU wave and buoyancy model can remain locally tangent because it operates
near the vessel, where planetary curvature is negligible.

### 6.3 Near and far ocean proposal

Use two representations:

1. **Detailed near ocean** — retain the current radial ocean and its exact
   buoyancy/render wave contract. Add planetary curvature without changing its
   local wave coordinates.
2. **Cheap far ocean** — a coarse curved annulus or shell beyond the detailed
   range, used only where camera height exposes sea beyond the near disc. It
   should use no small geometric waves, no foam simulation and no expensive
   residual-detail loop. It may retain only a few longest waves or use
   statistical roughness and the existing sky reflection/haze inputs.

The representations overlap across a measured transition band. Long-wave
height, colour, roughness and haze must converge through this band so it does
not form a ring.

An embodied observer sees a sea horizon around 8–12 km, normally inside the
existing detailed disc. In that view the far ocean should be below the curved
horizon and cost almost nothing. It primarily exists for the high cinematic
view, whose sea horizon is currently about 58 km.

### 6.4 Wave work with distance

The current ocean already fades geometric and procedural detail with footprint
and distance, and the residual-wave active window avoids evaluating every slot
where it cannot contribute. A separate far material gives a stronger guarantee:
the expensive near-ocean fragment program is not invoked for far-only water.

The renderer spike should compare:

- the existing wave LOD extended over a curved larger disc;
- the proposed detailed-disc plus cheap-annulus split;
- a far annulus with zero geometric waves;
- a far annulus retaining only the longest four to eight components.

The choice is made from image comparison and GPU timing, not from the apparent
complexity of the shader source.

### 6.5 Coastline intersection

The Copernicus Water Body Mask is the canonical land/ocean classification.
Terrain continues below mean sea level through a coastal band, allowing waves
to intersect a sloping shore instead of meeting a vertical wall.

The regional spike may initially rely on:

- WBM-shaped land geometry;
- an underwater terrain extension;
- depth ordering between terrain and ocean.

The production path adds a tiled coast signed-distance or categorical field to
clip ocean over land and drive wetness, foam and material transitions. This is
especially important for flat coasts, inland depressions, narrow channels,
atolls and local overrides.

Terrain should be submitted before the expensive ocean surface when doing so
allows ordinary early-depth rejection of ocean fragments hidden behind land.
This means visible land can replace, rather than simply add to, part of the
ocean fragment cost.

### 6.6 Reflection limitation

The ocean's reflection path currently samples only sky and clouds. Visible
land therefore does not appear in water reflections, including at close range
where a real coast would clearly mirror in calm water. This is an accepted
limitation of the first regional result. It must be recorded in the R2 review
checklist so a missing reflection is judged as the known limitation rather
than as a terrain defect. A terrain-aware reflection approach is deferred
production work.

## 7. Camera and depth strategy

The current camera combines a 6 cm embodied near plane with a 25 km far plane.
Simply changing the far value to 300 km risks inadequate depth precision at
coastlines and overlapping terrain.

The renderer spike must compare at least:

1. conventional depth with the existing mode-dependent near planes;
2. logarithmic depth, including its effect on the custom ocean and temporal
   shaders and early-depth performance;
3. reversed depth where target browser/GPU support permits it;
4. a two-range render/composite path that gives near ocean, vessel and terrain
   a separate precision range from distant silhouette terrain.

These candidates interact with the terrain-before-ocean optimisation in §6.5.
Fragment-shader logarithmic depth writes `gl_FragDepth`, which disables early
depth rejection for that draw — precisely the saving terrain-before-ocean
counts on for the expensive ocean program. The logarithmic-depth test must
therefore measure ocean fragment cost behind land, not only image correctness.

Expectations to budget around, recorded here so the tests are sized honestly:

- conventional 24-bit depth is expected to fail at coastline ranges — error
  grows roughly as `z^2 / (near * 2^24)`, about 400 m at 20 km through the
  6 cm embodied near plane and roughly 95 m through the measured 0.25 m
  default-cinematic near plane — so it is run as a cheap control, not a
  contender. The R0 camera-geometry baseline showed the near plane is
  adaptive: the maximum cinematic view already raises it to about 5.3 m,
  which softens (without solving) precision at range in that one view;
- reversed depth via `EXT_clip_control` (with three.js's native
  reversed-depth support) is the expected winner where the extension exists,
  with logarithmic depth as the fallback path elsewhere.

The chosen solution must pass:

- embodied camera at its 6 cm near plane;
- default cinematic view;
- maximum cinematic view;
- coastline overlap and underwater continuation;
- tall terrain from 1, 5, 20, 80 and at least 200 km;
- slow camera orbit, vessel movement and LOD transitions;
- OceanTemporalResolve enabled and disabled;
- supported desktop and mobile browser paths.

This is a genuine design risk and should be settled with synthetic geometry
before downloading or processing large real datasets.

## 8. Terrain shading and atmosphere

### 8.1 First visual pass

The first real-region result needs only:

- decoded terrain normals;
- ordinary direct Sun and Moon slope lighting;
- the existing world PBR diffuse/specular environment;
- a small set of procedural rock, soil and vegetation-mass colours;
- deterministic low-frequency colour variation;
- a crude distance/elevation haze blended toward the existing directional sky.

This is enough to judge silhouette, scale, coastline and broad material
plausibility.

### 8.2 Deferred lighting work

The vessel-focused shadow map must not simply be expanded to cover terrain.
Later terrain shadow candidates include:

- offline terrain-horizon angles sampled in a small number of azimuth bins;
- cascaded near-terrain shadow maps;
- a terrain-heightfield ray or screen-space method;
- authored/baked local shadows for hero areas.

The first regional spike may omit cast terrain shadows. Back-facing slopes still
receive correct direct-light rejection from their normals; missing valley and
occlusion shadows are accepted as a known visual limitation for that gate.

The vessel's own shadow map also does not currently project onto terrain: an
anchored ship casts no shadow on a nearby beach or shallows. This is deferred
with the rest of the terrain shadow work and recorded as a known limitation.

Weather integration is also deferred. The initial haze exposes a small
visibility-distance input so a later weather system can replace the constant
without replacing the terrain material architecture.

### 8.3 Cloud and terrain occlusion

The marched cloud volume is composited as sky: it renders with depth testing
disabled and has no knowledge of scene geometry. Terrain breaks the
assumption behind this. A cloud bank a few kilometres away must be able to
occlude a mountain a hundred kilometres away, and a near headland must
occlude clouds behind it; today there is no mechanism for either direction.
In addition, the existing horizon cloud band terminates a few degrees above
the horizon — exactly the elevation band in which distant peaks appear.

The renderer spike must therefore include a synthetic tall peak viewed with
the cloud field both in front of it and behind it, plus the horizon-band
case, and must settle the occlusion mechanism. The likely shape is the cloud
march or its composite consulting scene depth; the decision, its GPU cost and
its interaction with the temporal cloud cache are recorded as part of the R1
verdict.

## 9. Offline data and runtime delivery

### 9.1 Raw data does not ship to players

Copernicus DEM, Water Body Mask, WorldCover and optional sources are offline
build inputs. They live in a controlled build cache or object store with pinned
versions, checksums and licence records.

The game server or CDN hosts only compact, immutable, game-owned derived tiles.
Players do not download GeoTIFF source archives and the game does not query a
third-party geospatial service at runtime.

### 9.2 Streaming model

A web build can host a complete derived global hierarchy while each browser
fetches only:

- a small coarse global fallback and manifest;
- terrain tiles inside the current visible and prefetch regions;
- higher-resolution children only when screen error requires them;
- local hero packs only near those locations.

Tiles use immutable versioned URLs and CDN caching. A browser-side LRU cache in
Cache Storage or IndexedDB supplements the normal HTTP cache. Decode and mesh
preparation occur in Web Workers, with cancellation when a requested tile is no
longer useful.

The complete server-side hierarchy is still a storage, build-time and CDN-cost
concern. It should be sparse:

- coarse global terrain everywhere;
- medium terrain over land and important visible highlands;
- 30 m terrain primarily in coastal corridors and selected voyage regions;
- protected small islands at the LODs where gameplay requires them;
- separate authored hero packs.

The raw source size therefore does not block the renderer spike. Before a
global build, the streaming spike must measure real compressed tile sizes and
extrapolate server storage and voyage egress from evidence rather than sample
counts alone.

### 9.3 Initial tile payload

The first regional tile schema should contain only:

- quantised height plus per-tile minimum and scale;
- land/ocean/lake/river class or compact land mask;
- geometric error, min/max height and bounds;
- enough edge and parent data for stable LOD;
- schema and terrain-build version.

Slope, coast distance, material weights, ecoregion and vegetation statistics
are added only after the height/water pipeline and delivery path pass their
gates.

## 10. Performance design

### 10.1 Cost model

Important distinctions are:

- increasing a camera far plane does not itself shade more pixels;
- ocean curvature is a few vertex operations and should be negligible;
- a submitted terrain tile adds vertex, draw-call and memory cost;
- terrain pixels above the sea horizon add fragment cost;
- terrain drawn before hidden ocean can save expensive ocean fragments;
- far terrain can be extremely coarse because silhouette dominates;
- the far ocean appears mainly in the maximum cinematic view and can use a
  purpose-built cheap material;
- vegetation, not bare terrain, is likely to become the later draw-call and
  overdraw risk.

### 10.2 Required profiling

Every renderer spike capture records:

- presented frame time and resolution;
- complete GPU frame time where available;
- near-ocean and far-ocean GPU contributions;
- terrain depth/geometry and terrain beauty contributions;
- visible, requested, decoded and resident tile counts;
- terrain vertex and triangle counts;
- GPU terrain bytes and CPU/cache bytes;
- request latency, decode time and cancelled work;
- open-water baseline for direct comparison.

The ordinary embodied and default cinematic views should not pay a material
cost for a far-ocean path hidden below the horizon. Maximum cinematic view may
cost more, but it receives a separate measured budget rather than silently
reducing resolution everywhere.

### 10.3 Quality tiers

Mobile/low-power tiers may change:

- terrain screen-error threshold;
- maximum far-terrain visibility under haze;
- far-ocean tessellation and wave subset;
- material texture resolution;
- vegetation distance and density;
- cache and resident-memory budgets.

They must not change canonical coastline or land occupancy in a way that lets a
gameplay-critical island disappear.

## 11. Gameplay land blocking

Rendering is not authoritative for travel. A later `TerrainWorldQuery` exposes
at least:

```text
waterClassAt(latitude, longitude)
terrainHeightAt(latitude, longitude)
segmentIntersectsNonNavigableLand(start, end)
```

`PlanetaryWorld` or a navigation layer consults this query before committing a
voyage segment. The first behaviour can simply stop the vessel before land;
grounding, collision response and navigational bathymetry are later systems.

### 11.1 Water-aware opening resolution

The authored opening at the time was a city centre, and the coarse real mask
correctly classified it as land. TERR-G006 implements a bootstrap resolver for explicit
`?terrain=global` only; shipping continues to default to synthetic terrain and
the authored constants remain unchanged.

The resolver is pure and sits above the shared coarse source, not inside the
renderer. It receives the authored anchor, outbound course, minimum coast
clearance and a bounded search profile. An already-valid water anchor returns
bit-identically. Otherwise, deterministic expanding geodesic rings provide
candidates; each must be water and meet that same source's nearest-land
threshold. The first accepted ring is the minimum-displacement candidate in
the fixed lattice. Bearing proximity to the authored course and clockwise
order settle ties.

The result records authored and resolved coordinates, displacement, clearance,
source build and reason. `RuntimeUi` retains that immutable result and both
World panels publish it; exhausting the bounded search is an explicit startup
error. The explicit exact-pole tangent gauge, antimeridian wrapping, unchanged
water identity, land-opening integration, clearance, ties and bounded failure are
covered by focused tests.

This bootstrap decision is consumed once while constructing `PlanetaryWorld`;
it does not create a second mutable position. Explicit-global World-panel globe
clicks reuse the same query: qualified ocean is exact, qualifying coastal/land
selections relocate, and lattice exhaustion leaves canonical position unchanged. Other
programmatic teleports, collision, grounding, routing and navigational
clearance remain deferred.

## 12. Risk-reduction programme

The risks are ordered by how cheaply they can invalidate a large amount of
later work.

| Priority | Unknown | Cheapest decisive test | Passing evidence |
|---:|---|---|---|
| 1 | Long-range depth works with the 6 cm near plane | Synthetic height tiles at 1–300 km under every camera mode | No coastline ordering errors or unstable depth; selected strategy documented |
| 2 | Curved near/far ocean joins land without a false horizon | Synthetic curved island plus detailed ocean and cheap annulus | No gap, wall, drowning or visible ocean seam in motion |
| 3 | Terrain is affordable beside the ocean | GPU A/B of open water, synthetic land and high cinematic far sea | Ordinary views retain budget; high view has a bounded measured increment |
| 4 | Terrain and the cloud volume occlude each other correctly | Synthetic 3,000 m peak with the cloud field in front of and behind it, including the horizon cloud band | Chosen occlusion mechanism documented; no punch-through in either direction |
| 5 | ECEF-anchored tiles remain stable during accelerated travel | Move past a fixed synthetic tile, cross a tile boundary and rebase continuously | No jitter, swimming, coordinate drift or phase coupling with waves |
| 6 | 30 m public data looks good enough at game distances | One real coastal AOI at 1, 5, 20 and 80 km | Recognisable silhouette and plausible shoreline after basic synthesis |
| 7 | LOD transitions preserve silhouettes | Three real-data LODs with slow cinematic orbit and travel | No cracks, peak collapse, island loss or visible morph pulse |
| 8 | Web delivery is viable | Representative compressed pack under network throttling and cache churn | Bounded request count, decode time, resident memory and no visible holes after warm start |
| 9 | Global topology survives edge cases | One cube-face/antimeridian case plus a low atoll | Bit-identical shared edges and protected land persistence |

Terrain self-shadowing, vegetation, historical periodisation and hero-location
authoring are not allowed to obscure these earlier verdicts.

## 13. Phased implementation

### R0 — Documentation and baseline

- preserve the research guide;
- approve this game-specific design;
- record current camera and GPU baselines in the required views;
- define provisional GPU, memory and network budgets.

### R1 — Synthetic renderer capability spike

- add ECEF-anchored synthetic terrain tiles;
- test far-plane/depth alternatives;
- curve the detailed ocean consistently across its passes;
- prototype the cheap far-ocean annulus;
- intersect a synthetic island with the ocean;
- test cloud/terrain occlusion against a synthetic tall peak;
- add temporary distance haze;
- capture and benchmark every camera mode.

This phase contains no geospatial acquisition and no production tile streamer.

### R2 — Regional real-data spike

- acquire a small Copernicus DEM/WBM area;
- generate three deterministic LODs;
- load them through the provisional runtime tile interface;
- render one South Australian island/coast region;
- judge real silhouette and coastline quality;
- measure payload and resident GPU cost.

WorldCover is optional in this phase. Basic slope/elevation material synthesis
is enough for the primary verdict.

### R3 — Delivery and cache spike

- define the first binary tile schema;
- serve a representative regional pack from immutable URLs;
- add request deduplication, cancellation and worker decode;
- add disk and memory LRU behaviour;
- test cold, warm, throttled and offline-fallback starts;
- extrapolate a sparse global build.

### Gate A — Production architecture decision

Proceed only when depth, ocean integration, visual fidelity and delivery all
have evidence-backed solutions within budget. At this gate choose:

- production globe address hierarchy;
- camera/depth solution;
- detailed/far-ocean split and transition distance;
- tile sample dimension and encoding;
- global/coastal coverage tiers;
- CDN/cache profile;
- initial target regions.

### P1 onward — Production system

After Gate A:

1. build the global coarse hierarchy and regional terrain tiers;
2. add coast distance and semantic terrain materials;
3. add versioned streaming and prefetch;
4. add ecoregion-driven vegetation mass and then near instances;
5. add local delta patches for ports and important landfalls;
6. add CPU land blocking;
7. add historical periodisation;
8. run the complete regression and world-build programme.

## 14. Accepted and pending decisions

### Accepted for planning

- Retain the dataset research guide as a separate reference.
- Create separate game-system design and project-status documents.
- Preserve the canonical WGS84/ECEF and vessel-centred render architecture.
- Stream compact derived terrain tiles rather than source geospatial products.
- Use synthetic geometry to settle renderer risks before building real-data
  infrastructure.
- Prove one regional area before building the global hierarchy.
- Keep terrain shading, vegetation and historical reconstruction out of the
  first renderer gate.
- Water-qualify explicit-global globe clicks; defer other teleport handling and
  simple land blocking until after visual terrain.

### Pending evidence

- final maximum cinematic height;
- production maximum terrain visibility range;
- conventional, logarithmic, reversed or partitioned depth;
- exact detailed/far-ocean boundary;
- number of long waves retained in the far ocean;
- cube-sphere versus another globe hierarchy;
- 129 or 257 terrain samples per tile;
- tile compression and transport packaging;
- browser memory/disk cache budgets;
- global versus coastal high-resolution coverage;
- terrain self-shadow implementation;
- cloud/terrain occlusion mechanism;
- terrain-aware ocean reflection approach;
- first historical and authored hero locations.

## 15. Recommendation

Begin with R1, not a global download. The decisive first artefact is a synthetic
curved island rendered beside the existing ocean at near and extreme ranges,
with camera-depth variants and GPU timings. If that succeeds, R2 determines
whether the chosen real datasets produce land that is recognisable and
attractive at Drift's actual camera distances. Only after those two results
should the project pay for production tiling and global publication.
