# Depth-strategy candidates: measured R1 desktop verdict

2026-08-07. TERR-111/112/113 implementation, image checks and uncontended GPU
comparison. Machine-readable results:
`evidence/terrain/depth-candidates/performance.json`. Measured revision
`e1168b2` (depth implementation `d65cb92`), Apple M2 / ANGLE Metal,
Headless Chrome 151, 1600×913 at DPR 1.

## Decision

**Use reversed-Z as the R1 desktop candidate where `EXT_clip_control` is
available. Keep logarithmic depth as a compatibility fallback, but do not call
that fallback budget-clean yet. Conventional depth remains the control, not a
250–300 km production candidate.**

Reversed-Z was active (not a silent fallback), is image-correct including the
ocean TAA path, and showed no open-water performance tax. In the paired 21 km
peak case its terrain-on frame increment was **0.572 ± 0.065 ms SE**, inside
the ordinary-view 1.0 ms budget and indistinguishable from conventional's
**0.594 ± 0.097 ms**.

Log depth's open-water cost was not separately resolvable, but once land was
drawn before water its combined increment was **1.223 ± 0.102 ms SE**. That is
**0.651 ± 0.121 ms SE more than reversed-Z**; the approximate 95% interval for
the penalty is +0.409…+0.892 ms. The log candidate therefore exceeds the
ordinary-view budget in this stress composition. This is the measured price
of the r185 `gl_FragDepth` path preventing the hidden-ocean early-depth saving,
plus any log-depth terrain shader cost; the current prefix profiler cannot
separate those two components without TERR-134's dedicated buckets.

This is the desktop implementation verdict. TERR-115 remains in progress
until the 80–300 km moving/jitter matrix and a lower-power/browser capability
check validate the preferred path and its fallback.

## The switch

`?depth=conventional | log | reversed` — chosen at renderer construction
(three fixes both options at context creation; an A/B is two page loads).
Absent the parameter, production is bit-identical to before: both flags off,
no custom sort comparators, no behavioural change. An unknown value throws on
load rather than silently measuring the wrong candidate.

On any explicit `?depth=`, one console line records the capability matrix for
evidence, e.g. on this machine (Apple Silicon, Chrome):

```
[depth] requested=reversed active=log:false,reversed:true EXT_clip_control=true depthBits=24
```

Fallback behaviour (verified by three's own path): `reversedDepthBuffer: true`
without `EXT_clip_control` warns and keeps a conventional buffer — the
capability line then shows `reversed:false`, which IS the recorded fallback
observation. The log-depth candidate needs no extension at all.

## What each mode needed

- **Conventional** — nothing. Control.
- **Log** (`logarithmicDepthBuffer: true`) — three defines
  `USE_LOGARITHMIC_DEPTH_BUFFER` on every program but only materials whose
  GLSL includes the logdepthbuf chunks act on it; a custom material that
  skips them writes conventional depth into a log-encoded buffer and
  coastline occlusion silently breaks. Wrappers live in
  `src/scene/shaders/lib.ts` (`GLSL_LOG_DEPTH_*`); wired into **Ocean**
  (writes depth), **StarField** and **CrestSpray** (depth-tested against
  terrain/ocean). All other customs are either MeshStandardMaterial-derived
  (built-in chunks), `depthTest:false` composites, or self-consistent
  offscreen passes (FoamField, OceanTemporalResolve). In r185 the fragment
  chunk ALWAYS writes `gl_FragDepth` — the early-z kill the design worries
  about is real and applies to every chunked material. The paired result below
  prices its practical combined effect.
- **Reversed** (`reversedDepthBuffer: true`) — the projection reversal itself
  is free for app code (three stamps `camera.reversedDepth` and the reversed
  matrix flows through the `projectionMatrix` uniform; per-frame fov/near
  rewrites keep it because `makePerspective` re-reads the flag). Two app
  fixes were required, both mode-agnostic and safe in production:
  1. Fullscreen passes held bare `new THREE.Camera()` instances (CloudDome
     bake, SkyRadianceLut, WorldRadianceSource). Three's reversed path calls
     `updateProjectionMatrix()` on every camera it renders with; the base
     class has none — uncaught TypeError, dead render loop. Swapped to
     `OrthographicCamera(-1,1,1,-1,0,1)` (the codebase's own pattern in
     FoamField/OceanTemporalResolve); their shaders write clip-space
     directly, so the matrix is unread either way.
  2. **three r185 bug**: `WebGLRenderList.sort()` implements reversed-depth
     ordering as a wholesale `list.reverse()` AFTER the painter sort, which
     flips `renderOrder` semantics along with z. The sky dome's
     renderOrder -1000 ("draw first, everything covers me") became "draw
     last": the whole scene rendered correctly and was then painted over
     with sky. Three's own `scene.background` bypasses the render lists, so
     upstream doesn't trip on it. Workaround in `main.ts` (active only when
     the reversed capability is on): custom opaque/transparent comparators
     that emit the exact opposite of the desired order so the trailing
     reverse() restores painter order with the correct reversed-z
     front/back. Check whether newer three fixes this before upgrading.

Ocean TAA (`?oceanTaa=1`) compiles and renders under both log and reversed.

## GPU evidence

The repeatable runner is `tools/run-terrain-depth-benchmarks.mjs`. It made two
symmetric-order runs per mode. Each open-water run used the six R0 views and
24 retained six-frame rotations per view. Every view maintained the presented
60 Hz cadence.

Frame medians averaged across the two runs:

| R0 view | Conventional | Log | Reversed |
|---|---:|---:|---:|
| Embodied forward, midday | 6.770 ms | 6.878 ms | 6.444 ms |
| Embodied toward low Sun | 6.894 ms | 6.599 ms | 7.142 ms |
| Default cinematic, midday | 8.516 ms | 6.855 ms | 6.617 ms |
| Default cinematic, rough/low Sun | 8.600 ms | 8.590 ms | 8.265 ms |
| Maximum cinematic, midday | 6.575 ms | 6.429 ms | 6.373 ms |
| Maximum cinematic, rough/low Sun | 8.342 ms | 8.345 ms | 8.335 ms |

Page-load comparisons carry more drift than the paired result; in particular,
the conventional default-midday row was high in both runs. The stable
rough/low-Sun maximum row differed by +0.003 ms for log and −0.007 ms for
reversed. Across the matrix there is no evidence of a systematic open-water
cost for either candidate. These current-master controls supplement rather
than overwrite the 2026-08-06 R0 baseline.

The occlusion bracket used the six-tile, 196,608-triangle peak at 21 km,
default cinematic view, clear 500 km haze, and terrain `renderOrder = -1`
before the ocean's order 0. Each of two runs per mode retained 16 alternating
hidden/visible pairs and eight six-frame rotations per leg. Pooled terrain-on
minus terrain-off results (32 pairs per mode):

| Mode | Complete frame | Terrain + ocean cumulative prefix | Later scene tail |
|---|---:|---:|---:|
| Conventional | +0.594 ± 0.097 ms | +0.574 ± 0.105 ms | −0.029 ± 0.046 ms |
| Log | +1.223 ± 0.102 ms | +1.156 ± 0.079 ms | −0.038 ± 0.052 ms |
| Reversed | +0.572 ± 0.065 ms | +0.587 ± 0.089 ms | −0.105 ± 0.047 ms |

Values are mean ± SE. Because prefix queries begin at the frame boundary, the
profiler endpoint named `ocean` in the raw measured-revision reports includes
terrain when terrain renders first. The committed aggregate names it honestly
as `terrainAndOceanPrefix`; it is not an ocean-only timer. The complete-frame
paired result is the acceptance instrument.

## Image findings (the surprise)

**DEPTH-01 does not reproduce as depth error.** With foam zeroed and haze
pushed to 500 km, at the headland coastline from 6 km:

- conventional vs reversed stills are near-identical (0.1% of pixels in the
  6× coastline crop, small deltas confined to the 4–5 boundary rows);
- 48-frame temporal luminance variance per row is IDENTICAL between modes
  (peak 2.9 at the waterline in both — that is waves lapping, not shimmer);
- this holds through the default cinematic near plane (~0.28 m, ~8 m
  quantization at 6 km) AND the embodied 6 cm near plane (~36 m quantization
  at 6 km), where a fringe would have to show if it ever would.

The white "dashes" along the coastline that read as a z-fight fringe are
**pinned to the terrain shore and bit-identical across depth modes** — they
are shore-adjacent rendering (scaffolding palette / grazing-angle
rasterization of the shoreline), not depth fighting. Evidence:
`evidence/terrain/depth-candidates/` (untracked), esp.
`noFoam-{conventional,reversed}-coast.png`.

Two consequences:
1. The visible-artefact case for abandoning conventional depth at ≤10 km is
   currently EMPTY in this scene. The case rests on far-range coastlines
   (design §7's 95–400 m errors at 20 km+), which flat terrain compresses to
   sub-pixel at the horizon — it becomes photographable only once curvature
   (TERR-120+) lifts distant terrain, or in motion at ranges/views not yet
   exercised.
2. DEPTH-01's original by-eye observation should be treated as unconfirmed
   attribution: what was seen at 6–10 km was plausibly this mode-independent
   shoreline band. TERR-115's verdict should lean on measured GPU cost +
   design-range arithmetic, not on the 6 km fringe.

## Also found while here (not fixed)

- **Stars punch through terrain**: `STAR_RADIUS = 485` m puts the star dome
  nearer than any terrain; depth testing can never let a 6 km headland
  occlude a star in ANY depth mode. Same family as TERR-137 cloud occlusion.
  Needs its own fix (far-plane stars, terrain-aware star mask, or scaled
  dome).
- The ocean's shadow-caster twin (`Ocean.shadowMaterial`, off by default)
  writes flat `vec4(1.0)` and was left out of the log-depth wiring — re-wire
  it before re-arming the sun-shadow A/B under log depth.
- Harness traps: a page loaded while the agent pane is hidden reports
  `innerWidth 0` and keeps a 2×2 canvas until the pane composites once
  (screenshot first, then drive); `renderer.info.render` resets per
  `render()` call, so under TAA it shows only the final present pass.

## Remaining validation

- Run conventional and reversed through TERR-103's 80–300 km moving/jitter
  matrix. The 6–10 km shoreline finding cannot substitute for that range.
- Record reversed-Z capability and log fallback cost on the deferred
  lower-power/browser tier.
- TERR-134 should split terrain and ocean into dedicated profiler buckets;
  this round deliberately reports the existing cumulative prefix honestly.
- Before re-arming the optional ocean shadow caster under log depth, wire its
  shadow material to the log-depth chunks.

## Profiler bucket change, 2026-08-17 (read before comparing numbers)

Every figure in this record was taken when the profiler's `ocean` bucket ran
from the sky dome's draw to the sea's — so it contained the **vessel** (hull at
renderOrder −2, interior at −1) and the **terrain** as well as the sea. TERR-134
split those into `sceneOpaque`, `terrain` and `ocean`, and lengthened a rotation
from six frames to eight.

Consequences for anyone re-running `tools/run-terrain-depth-benchmarks.mjs`:

- The paired terrain-on-minus-off DELTAS here remain valid — pairing cancels
  everything that does not change between the arms, and the vessel does not.
- The absolute bucket values do not. A post-split `ocean` is the sea alone.
- The runner still emits `terrainAndOceanPrefix` for exactly this reason, so the
  new evidence stays comparable with the old on the one key that was quoted.
- The forced `renderOrder = -1` this benchmark used to write onto each tile is
  now `setTerrainDrawOrder('before')`, the same switch `?terrainOrder=` and the
  A/B registry move — so the profiler's endpoint rotation follows the order and
  the terrain bucket stays a terrain bucket.
