# Runtime architecture

**Status:** current runtime contract

**Date:** 2026-08-10
**Direction:** behavior-preserving consolidation in place

This document is the short route to the application's current runtime
architecture. It supersedes the runtime-topology observations in
`ARCHITECTURE_CONSOLIDATION_PROBLEM.md`, which remains the historical problem
inventory for baseline `bd77792`. Subject specifications and handovers still
own domain rationale and accepted visual or physical decisions.

The consolidation deliberately does not rewrite Three.js, the planetary world,
the physical sea, vessel integration, procedural content, visual policy, or
evidence protocols. It gives their existing behavior named, testable owners.

## Dependency direction

```text
main.ts (composition, lifetime, host selection)
  |
  +-- RuntimeOptions / RuntimeQuality / createRuntimeRenderer
  +-- BrowserViewport / BrowserFrameDriver / RuntimeUi
  +-- ProductionSimulationRuntime
  |     +-- VesselRuntime
  |     +-- EnvironmentRuntime
  |     +-- WakePresentationController
  |     +-- domain and presentation systems
  +-- RenderPipeline
  +-- RuntimeDiagnostics / evidence-host launchers
          +-- SimHandle compatibility contract

debug and evidence modules
  +-- explicit per-tool SimCapability contracts
  X-- main.ts
```

`src/main.ts` is a composition root: it selects immutable host policy,
constructs the concrete graph once, connects the owners above, starts one host,
and registers the existing teardown. It does not implement simulation phases,
browser-frame policy, renderer construction, panel behavior, benchmark
scenarios, visual readback, or capture algorithms.

Runtime and debug dependencies point away from the browser entry module. Debug
modules import `src/runtime/diagnostics/SimHandle.ts`; the type-only re-export
from `main.ts` is compatibility for external callers, not an inward dependency.

## Runtime owners

| Owner | Authority | Stable products or entry points |
|---|---|---|
| `ProductionSimulationRuntime` | The seven production phase bodies, their profiler spans, surface-effect preparation, and phase transaction | One stable `step` callback |
| `VesselRuntime` | Active-vessel motion and tow policy, navigation and wind sampling, physical/presentation contexts, pose, deck walker, camera, ocean masks, rig refresh, and current vessel telemetry | Encounter velocity, navigation record, contexts, camera anchor, control ports |
| `EnvironmentRuntime` | Astronomy and transported world frame derivation, weather/sky publication, direct shadows, world radiance, exposure, and scene-light publication | Astronomy frame, render adapter, lighting references, shadow and exposure controls |
| `WakePresentationController` | Completed contact capture, wake feature policy, wake appearances, and foam wake sources | Contact graph, policy results, hull and waterline foam sources |
| `BrowserFrameDriver` | Normal browser callback timing, diagnostic freeze, profiling bootstrap, readback/capture placement, adaptive DPR, and the post-frame UI hook | Stable `frame`, `resetCadence`, and reading records |
| `BrowserViewport` | Immediate resize, per-frame size polling, and trailing resize debounce | Stable viewport callbacks and reading |
| `RuntimeUi` | Developer-tools shell, lazy panel loading, live panel trims, performance readout, and deep links | Stable update/open/dispose operations and live trim getters |
| `RenderPipeline` | Terrain refresh and temporal-versus-direct render submission | One render transaction |
| `RuntimeDiagnostics` | Composition of benchmark and visual diagnostic suites around one exclusive execution gate | Benchmark, readback, capture, and evidence commands |

These are orchestration boundaries, not a service framework. Concrete domain
objects are still directly constructed and passed once. `VesselRuntime` is an
active-vessel facade and is intentionally the broadest production owner; UI,
browser, diagnostics, environment, and render-submission policy must not be
added to it. Its telemetry is the cleanest later split if it grows.

## Startup and configuration ownership

- `RuntimeOptions` is the parser for constructor-critical browser and URL
  policy: device tier, debug vessel or host, fixed DPR, temporal-ocean startup,
  depth mode, cloud-march override, interior presentation mode, direct-shadow
  startup, terrain mode, and capture port.
- `RuntimeQuality` coordinates ocean, foam, spray, cloud-cache, and pixel-ratio
  presentation budgets. It has no authority over physical wave slots; the
  vessel feels the same sea on every tier.
- `createRuntimeRenderer()` owns WebGL construction, depth capability reporting,
  the reversed-Z ordering workaround, colour and tone defaults, clear state,
  and shadow-map defaults.
- `RuntimeLifecycle` detaches its registered `EventTarget` listeners before it
  invokes the composition root's existing resource cleanups. Consolidation does
  not silently widen the resource set disposed on unload.
- The composition root constructs exactly one active vessel and one
  `WaveField`.

Configuration now falls into these categories:

| Category | Owner | Lifetime and validation |
|---|---|---|
| Canonical or authored model | Sea, hull, sailing, world, and renderer-domain modules | Source-controlled; domain validated |
| Immutable host intent | `RuntimeOptions` | Parsed and named once before construction |
| Coordinated startup presentation budget | `RuntimeQuality` | Selected once; preserves protected physical invariants |
| Adaptive host state | `BrowserFrameDriver` | Session-only DPR state, evaluated at the existing cadence |
| Live presentation trim | `RuntimeUi`, `EnvironmentRuntime`, and effect owners | Session-only; read live and never written to canonical world state |
| Temporary diagnostic override | `RuntimeDiagnostics` and `SimHandle` commands | Scoped by a scenario's snapshot/restore protocol |
| Evidence URL scenario | `startEvidenceHosts` | Cold host policy; implementation stays dynamically imported where applicable |

This taxonomy makes ownership visible but does not yet make quality/capability
policy complete. In particular, viewport heuristics, a desktop override,
experiments, and adaptive state are still distinct reasons represented by a
small set of values rather than a durable evidence record.

## Clock and distance policy

`RuntimeFrameClock` publishes one allocation-free record with two named deltas.
`rawRealSeconds` is the complete monotonic callback interval; `presentationSeconds`
is capped at 1/20 second, equal to twelve 1/240-second vessel substeps.
Deterministic diagnostics use one value for both meanings unless they supply a
separate raw-real delta.

| Quantity | Owner | Units and scaling | Freeze, pause, or reset behavior |
|---|---|---|---|
| Browser callback interval | `RuntimeFrameClock` | Host milliseconds to raw seconds and capped presentation seconds | Sampled even after stalls; non-monotonic input clamps to zero |
| Normal-loop diagnostic freeze | `BrowserFrameDriver` + shared diagnostic gate | Both simulation deltas become zero | Direct deterministic `step` calls remain available |
| Presentation elapsed time | `PresentationClock` | Ordinary capped presentation seconds | Explicitly settable by deterministic reset; independent of astronomy controls |
| Canonical UTC | `WorldClock` inside `PlanetaryWorld` | Raw real seconds multiplied by `worldSecondsPerRealSecond` | Canonical pause and astronomy controls apply only here |
| Vessel fixed integration | Active vessel | Presentation seconds accumulated into 1/240-second substeps | Zero steps still settle derived state; accumulator remains vessel-owned |
| Wave/contact instant | `WaveField` and buoyant body | Physical substep seconds | Advanced only by the active flotation body |
| Gust process | `WorldWind` | Ordinary physical seconds; seeded pure signal at substep instants | Reset is explicit; no random or callback-rate dependence |
| Global voyage distance | `PlanetaryWorld` motion boundary | Physical encounter distance multiplied by voyage-time compression | Astronomy rate and pause cannot alter it |
| Cloud/cache cadence | `SkySystem` and cloud-cache owners | Presentation and cache-specific time | Existing cache swap/settle semantics retained |
| Authored control work | Sailing and rig controllers | Ordinary physical seconds | Rate limits remain independent of world and voyage time |

The table is the responsibility map; the code still uses plain numbers rather
than branded delta and distance types. A future type-safety round may narrow
that risk without changing the clock domains.

## Spatial-frame vocabulary

| Frame or value | Convention | Conversion authority |
|---|---|---|
| Canonical Earth | WGS84 ECEF metres in double-precision JavaScript numbers | `PlanetaryWorld` and `world/wgs84` |
| Geodetic | Latitude/longitude radians and height metres | `world/wgs84` and geodesic helpers |
| Transported local surface | Right, up, forward basis retained in canonical state | `PlanetaryWorld` |
| Three.js render frame | Vessel-centred; `x=right`, `y=up`, `z=-forward` | `WorldRenderAdapter` is the Earth-scale boundary |
| Vessel horizontal dynamics | Render/body `+x` and `+z`; canonical forward is render `-z` | `PlanetaryVesselMotionBridge` negates displacement and velocity Z exactly once |
| Nearby terrain tile | Tile `X=east`, `Y=up`, `Z=south`, translated relative to the vessel in doubles | `WorldRenderAdapter.anchoredTileMatrix()` |
| Wake and foam fields | Stable vessel/contact products converted into field/grid conventions inside their owners | `WakePresentationController`, `WakeSources`, and `FoamField` |
| Ocean observer origin | Render-local camera/vessel blend; wave origin remains the physical-field origin | `ProductionSimulationRuntime` ocean phase |

The explicit bridge classes close the most dangerous current conversion seams,
but a fully typed spatial vocabulary does not yet exist. Ordinary Three.js
vectors and `{x, z}` records still represent several local meanings.

## Authoritative simulation transaction

`ProductionSimulationRuntime` owns the seven actual phase bodies, their named
profiler spans, and one private `SimulationFrameTransaction`. The composition
root passes its one stable `step` callback to both `BrowserFrameDriver` and the
deterministic `SimHandle` facade.

| Phase | Publishes or prepares |
|---|---|
| `advanceWorld` | Clocks, canonical travel input, sea state, wave heading, and mean/instantaneous wind |
| `integrateVessel` | Fixed-step vessel state, canonical ECEF commits, completed wave/contact instant, and wake contacts |
| `deriveEnvironment` | Post-motion astronomy, transported render frame, cloud/weather evolution, and lighting |
| `presentVesselAndCamera` | Vessel pose, deck walker, and camera |
| `updateSurfaceEffects` | Wake policy, foam simulation, spray, and salt loading |
| `prepareOcean` | Current foam targets, ocean origin/optics/environment, and vessel/lamp masks |
| `prepareScene` | Visible sky, stars, direct lights, paired world lighting, exposure, audio, and rig geometry |

The transaction reuses one step record and one spray-direction scratch. Contact
graphs, wake products, frame contexts, vectors, and long-lived policy views keep
stable identities. The pre-existing per-frame FoamField and Ocean option
literals intentionally keep their allocation shape in this refactor.

The nested 240 Hz integration remains inside the active vessel:

- `WaveField` advances once per physical substep through the flotation body;
- schooner displacement and end velocity commit to canonical ECEF state during
  each horizontal step through `PlanetaryVesselMotionBridge`;
- wake contact capture occurs immediately after the final physical instant;
- `VesselPhysicsContext` and `VesselPresentationContext` are distinct retained
  contracts, so lighting cannot appear valid to physics before derivation;
- zero-duration steps still settle and publish derived state.

## Browser presentation and UI

The browser-frame order is explicit and tested:

1. begin CPU frame and make the viewport current;
2. sample raw and capped deltas and update visible cadence;
3. begin GPU frame;
4. execute the shared simulation transaction, using zero deltas while a
   counterfactual diagnostic owns the renderer;
5. execute the render transaction and close the GPU frame;
6. complete profiler warm-up;
7. service framebuffer readback, then development capture;
8. evaluate adaptive DPR when eligible;
9. publish performance/UI readings and close the CPU frame.

`RuntimeUi` constructs the developer shell and persistent performance readout
synchronously in their established order. Every panel implementation remains a
dynamic import. Terrain waits for its late mount before importing its panel;
ocean and graphics obtain the synchronously bound `SimHandle` only after their
modules load. Deep links select the same shell after the animation loop is
installed. Hidden panels retain live trim state, and the UI tail reuses one
stats record rather than allocating an aggregate each frame.

## Render transaction

`RenderPipeline` owns this order:

1. begin render-submission profiling;
2. refresh render-time terrain anchoring;
3. choose temporal ocean resolve only when every compatibility gate permits it;
4. otherwise clear temporal jitter and issue the direct Three.js render;
5. close render-submission profiling.

Foam simulation, cloud-cache work, radiance-source rendering, and world-light
publication remain simulation preparation. Moving GPU work across that boundary
would be a renderer/performance decision, not a refactor.

## Diagnostics and evidence

`RuntimeDiagnostics` is a small facade over separate benchmark and visual
suites. The benchmark suite owns GPU sampling, paired comparisons, freeze and
warm-up, and restoration. The visual suite owns contact sheets, category
renders, framebuffer readback, and browser capture. They share one type-only
contract and one exclusive execution gate; neither imports `main.ts` or the
other suite. Specialised evidence modules remain dynamically imported when a
command starts.

The gate continues to couple four required behaviors: concurrent-run rejection,
normal-loop time freeze, temporal-resolve exclusion, and adaptive-resolution
suspension. Readback remains after render and before capture/adaptation.

Every ordinary debug factory now accepts an explicit `SimCapability<...>` key
set rather than the complete facade. These are type-only structural views over
the same runtime object, so they narrow compile-time authority without changing
object identity, property order, code splitting, or JavaScript output. Adding a
new `SimHandle` member therefore does not silently grant it to existing tools.

`SimHandle` itself remains a transitional compatibility superset. It
intentionally retains deterministic stepping, reset, inspection, benchmarks,
capture, and privileged concrete renderer access so existing evidence is not
broken by this behavior-preserving round. The full facade, the shared internal
diagnostics dependency record, and development-only `window.__drift` are still
broad; they must be treated as privileged and unstable rather than ordinary
runtime APIs. New production state must not be added to them merely because it
is convenient.

## Preservation rules

Refactors at these boundaries must preserve:

- one canonical planetary state and one Earth-to-render adapter;
- one shared CPU/GPU wave definition and one completed contact instant;
- per-substep canonical schooner commits and voyage compression only at the
  planetary boundary;
- mean wind for sea presentation and deterministic instantaneous wind for sail
  forces and cues;
- one-way physics-to-wake coupling;
- foam update before ocean texture rebinding;
- sky publication before world-lighting publication;
- rig refresh inside deterministic simulation stepping;
- terrain refresh inside every render path;
- profiler span names, dynamic debug imports, development globals, capture
  timing, and reset/warm-up semantics.

## Verification

Fake-based runtime tests execute the real production phase owner and pin the
literal seven-phase/profiler order, clock meanings, transition branch, shared
identities, wake/foam/spray/ocean formulas, scratch reuse, and live diagnostic
trims. Browser tests pin viewport debounce/poll, diagnostic and hidden-tab
semantics, profiler bootstrap, readback/capture/adaptation order, and callback
identity. Runtime UI tests pin synchronous construction, lazy import timing,
terrain awaiting, live trim state, update/dispose ordering, and record reuse.

Architecture tests additionally pin startup policy, coordinated quality,
render-path selection, lifecycle behavior, canonical-motion axis conversion,
one shared production `step`, and the debug-to-entry dependency rule. These
supplement the numerical, slow physical, shader/source, visual, and GPU evidence
suites described in `docs/project/TESTING.md`.

## Problem-inventory status

| Historical item | Current status |
|---|---|
| P1 composition root/evidence host | Resolved by separating assembly, production runtime, browser host, UI, diagnostics, and evidence implementations |
| P2 implicit frame mutation/order | Resolved at the application transaction level; nested domain contracts remain documented and tested |
| P3 clock and distance policy | Materially consolidated; responsibility map exists, branded types do not |
| P9 spatial-frame contracts | Dangerous conversion seams are explicit; a comprehensive typed vocabulary remains open |
| P10 quality/capability policy | Coordinated startup quality and adaptive DPR are separate; reason/evidence modeling remains partial |
| P11 diagnostic authority | Entry-module topology and ordinary per-tool authority are narrowed; the full compatibility facade, shared diagnostic dependencies, and `__drift` remain broad |
| P12 configuration categories | Named taxonomy and constructor policy exist; persistence and cross-domain validation remain partial |
| P4-P8 and P13-P15 | Separate domain, rendering, content, tooling, verification, and documentation concerns; not represented as solved by this runtime refactor |

The historical inventory remains useful for those open items. Future work
should be taken as bounded slices with its own semantic and performance
evidence, not by expanding `ProductionSimulationRuntime`, `VesselRuntime`, or a
new general-purpose application service.
