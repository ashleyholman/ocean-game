---
title: R1 synthetic fixture and harness specification
status: Proposed (immediate-queue item 5; implements TERR-100 through TERR-104 scaffolding)
design: terrain-system-design.md
plan: terrain-project-plan.md
last_updated: 2026-08-05
---

# R1 synthetic fixture and harness specification

## 1. Purpose

Settle what the R1 spike actually builds before building it: the fixture
shapes, where they sit on the real WGS84 globe, the experimental tile
interface, the anchored-transform contract, and how the harness drives and
captures it. Everything here is experimental and reversible; nothing touches
the production frame path unless its URL switch is present.

## 2. Test area

Fixtures are anchored in open water south-west of Kangaroo Island, around
36.5°S 136.5°E — real ocean, no land within the far plane, on the eventual R2
approach. Test scenarios spawn the vessel at explicit known-water coordinates
near each fixture rather than the default opening (design §11).

## 3. Fixture set (TERR-101)

Four deterministic analytic fixtures, each a heightfield on a geodetic
footprint, displaced along the geodetic normal (design §5.1), with an
underwater continuation to −60 m so no fixture has a vertical coastal wall
(TERR-130):

| ID | Shape | Peak | Footprint | Exercises |
|---|---|---:|---:|---|
| `low-coast` | Shelving plane with gentle dune ridges | 12 m | 8 × 3 km | Near-sea-level depth precision, drowned-coast failure, curvature sag at 20 km |
| `headland` | Asymmetric ridge falling to a cliff coast | 100 m | 4 × 2 km | Silhouette at 10–36 km, terrain-before-ocean depth ordering |
| `mountain` | Cone with two shoulder ridges | 500 m | 12 × 10 km | Mid-range LOD and haze, visibility to ~90 km |
| `peak` | Sharp massif on a broad base | 3,000 m | 40 × 30 km | Long-range depth to 254 km, horizon-band and cloud occlusion (TERR-137) |

Heights are pure functions of tile-local UV built from analytic profiles plus
a seeded value-noise ridge term — no RNG state, so a fixture is bit-identical
across runs and machines (the determinism every later checksum test assumes).
Each fixture also carries a land/water mask derived from its own height sign,
standing in for the WBM until R2.

## 4. Experimental tile interface (TERR-100)

The interface deliberately knows nothing about cube-sphere versus geographic
addressing (design §5.2):

```text
TerrainTileKey        opaque string identity
TerrainTileGeometry   anchorGeodetic {latRad, lonRad}
                      anchorEcef {x, y, z}          double precision
                      basisEcef {east, north, up}   double precision
                      spacingM                      sample step
                      samples                       2^n + 1 per edge (129 first)
                      heightsM                      Float32Array, row-major
                      minHeightM / maxHeightM       culling and depth bounds
                      geometricErrorM               0 for synthetic full-res
                      landFraction                  0..1
TerrainTileSource     tilesFor(fixtureId): TerrainTileGeometry[]
```

Fixtures larger than one tile are emitted as multiple tiles sharing edge
samples exactly (the `2^n + 1` grid makes shared borders reproducible), which
gives TERR-103/104 a real tile boundary to cross.

## 5. Anchored transform (TERR-102)

`WorldRenderAdapter` gains one operation (design §5.1 requires terrain not to
grow a second projection path):

```text
anchoredTileMatrix(tile: {anchorEcef, basisEcef}): THREE.Matrix4
```

ECEF subtraction (anchor − vessel) happens CPU-side in doubles; the returned
matrix carries the small render-frame translation plus the tile basis rotated
into the transported frame. Vertex buffers stay static Float32 tile-local
offsets forever; motion only updates matrices.

Numerical acceptance (vitest, no GPU): round-trip error of reconstructed
sample positions against direct geodetic→ECEF→render conversion stays below
1 mm for offsets within 5 km of the vessel and below 5 cm at 300 km, at the
equator, at the opening's latitude, across the antimeridian, at 80°S, and under
a transported frame rotated by a long synthetic voyage.

## 6. Runtime harness

- `?terrain=synthetic` mounts an experimental `TerrainSystem` with the
  fixture source. Absent the parameter, no terrain code runs — the ordinary
  frame is untouched by construction, which is what lets ordinary-view
  budgets be compared honestly.
- `&fixture=<id>&range=<km>&bearing=<deg>` selects composition; the harness
  places the fixture, not the vessel, so buoyancy and voyage state stay
  production.
- Depth-strategy candidates switch by URL too (`&depth=conventional|log|
  reversed`), because a reload per candidate is exactly what shader
  recompilation wants anyway.
- Captures and GPU numbers reuse the R0 pattern: a `?perf=terrain-r1` run
  drives the canonical view set through the same freeze protocol and posts
  JSON/JPEGs to the capture server (`evidence/terrain/r1-renderer/`).

## 7. Order of work

TERR-100/101 (interface + fixtures, pure CPU, unit-tested) → TERR-102
(anchored transform + numerical tests, pure CPU) → TERR-103 (first on-screen
render, needs GPU only for eyes, not timing) → TERR-110+ depth candidates
(needs uncontended GPU for the measured comparisons) → curvature and far
ocean (TERR-120+).

The first three stages are safe on a contended machine; everything measured
runs on a quiet one.

## 8. Non-goals for this spike

No real data, no network tiles, no LOD selection or morphing (single-LOD
fixtures), no coast SDF, no materials beyond slope lighting and constant
haze, no vegetation, no gameplay collision. R1 exists to answer depth,
curvature, cost, stability and cloud-occlusion questions — the fixture set is
the cheapest honest way to ask them.
