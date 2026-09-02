# Architectural consolidation — problem statement

**Status:** historical problem inventory for baseline `bd77792`

**Date:** 2026-08-10

**Baseline:** `bd77792`

> This document records the pre-consolidation architecture. It is intentionally
> retained as the problem and rationale inventory, not as a description of the
> current runtime topology. See
> [`RUNTIME_ARCHITECTURE.md`](RUNTIME_ARCHITECTURE.md) for current ownership,
> dependency direction, transaction order, preservation rules, and the explicit
> status of each runtime concern.

**Scope:** application runtime, world and vessel simulation, simulation-to-render
data flow, environmental rendering, procedural content, player movement,
terrain, shader and render-pass organisation, diagnostics, and verification

This document describes where the current architecture is strong and where it
is under pressure. It does not select a replacement architecture, prescribe a
rewrite, or propose a sequence of implementation tasks.

The purpose is to give a later design round a stable account of:

- what is structurally good and must not be lost;
- which difficulties are local implementation problems and which are
  architectural;
- where ownership, sequencing, coordinate frames, and contracts are implicit;
- which responsibilities belong to the game and which could belong to a
  renderer, engine, toolchain, or content pipeline;
- what evidence should be gathered before choosing a direction.

The central finding is:

> The codebase is coherent, deliberate, and unusually well verified for a
> browser game prototype. Its pressure comes from carrying an engine-sized
> combination of planetary simulation, vessel physics, procedural content,
> environmental rendering, and evidence tooling through a small number of
> mutable coordination surfaces.

Architectural consolidation is justified, but not because the foundation has
failed. It is justified because a single application entry module is the
authoritative frame scheduler, integration host, presentation coordinator,
diagnostic API, benchmark runner, and render-state owner for systems whose
individual contracts are substantially more mature than their shared runtime
contract.

---

## 1. What this document is not

This is not:

- a proposal to move to Unreal Engine, remain with Three.js, or choose another
  engine;
- a refactoring checklist;
- a class diagram for a replacement;
- a recommendation to introduce an ECS, dependency-injection framework,
  event bus, render graph, or any other particular pattern;
- a visual-quality review;
- a performance optimisation plan;
- an argument that procedural content or large files are inherently wrong;
- permission to relax physical, numerical, temporal, visual, or evidence
  invariants already established by the project.

Those are later decisions. The immediate job is to establish the problem
clearly enough that the first plausible solution does not become the answer by
default.

---

## 2. Current system at a glance

The application is a vertically integrated runtime for one active vessel in a
planetary ocean world. The production vessel is a procedural two-masted
schooner with force-integrated sailing, a walkable deck, and a first below-deck
interior. The raft remains a diagnostic vessel. Synthetic terrain is an
experimental, URL-gated client of the same canonical world and render adapter.

```text
Canonical world                         Authored physical state
---------------                         -----------------------
PlanetaryWorld                          SeaStateController
  ECEF position + velocity                wind sea + swell
  transported tangent frame                    |
  UTC / astronomy clock                 WorldWind
          |                               mean + deterministic gusts
          |                                      |
          +---------------+----------------------+
                          |
                 main frame coordinator
                          |
        +-----------------+-----------------------------+
        |                 |                             |
  vessel transaction   environment                 presentation
  ------------------   -----------                 ------------
  SailingControls      AstronomyProvider           DeckWalker
  sail forces          WorldRenderAdapter          CameraSystem
  resistance           TimeOfDay                   WakeSources
  horizontal dynamics  SkySystem / cloud cache     FoamField
  BuoyantBody           WorldLighting              CrestSpray
        |                 |                         Ocean
        +---- WaveField --+                         terrain hook
        |                                           vessel geometry
        +-- canonical ECEF motion commit                 |
                                                        v
                                              Three.js / WebGL renderer
                                              shadows / stencil / optional
                                              ocean temporal resolve

Diagnostics and evidence enter through SimHandle, direct development handles,
URL-selected harnesses, and specialised exporters.
```

The top-level source decomposition is meaningful:

- `src/world/` owns canonical WGS84 state, navigation, geodesic travel, time,
  frame transport, and instantaneous world wind;
- `src/astronomy/` derives celestial state from canonical position and UTC;
- `src/ocean/` describes and resolves physical sea states;
- `src/vessel/` owns the active-vessel contract, generic buoyancy and contact
  evaluation, vessel/world motion bridges, the diagnostic raft, and the
  schooner's geometry, hydrostatics, resistance, sailing, rig, and evidence;
- `src/scene/Waves.ts` evaluates the shared local wave field for CPU and GPU
  consumers;
- `src/scene/` owns the specialised sky, cloud, ocean, lighting, world-material,
  foam, spray, wake-presentation, star, lamp, and stencil systems;
- `src/terrain/` owns the experimental anchored-tile path and synthetic
  fixtures;
- `src/camera/`, `src/player/`, and `src/input/` own the active camera, the
  ship-local walking body, and interaction;
- `src/render/` owns profiling, adaptive resolution, ocean temporal resolve,
  and render-analysis probes;
- `src/debug/` and `src/ui/` own developer panels, deterministic visual
  evidence, and inspection tools.

The pressure is not primarily in the existence of these domains. It appears
where they must agree within a frame and where their development tools need to
reproduce that agreement outside the normal animation loop.

---

## 3. Baseline quality and evidence

At this baseline:

- TypeScript is configured in strict mode;
- the source and tests contain no `@ts-ignore`, `@ts-expect-error`, or obvious
  `as any` escape hatches;
- the repository contains **61 Vitest test files**;
- the test policy separates an everyday default suite from tagged, long-running
  sailing, ship-physics, and rig-geometry suites without removing their cheaper
  contract checks from ordinary feedback;
- deterministic exporters record world wind, ship response, resistance,
  dynamics, sailing, steering, and wake behaviour in committed evidence;
- numerical tests cover canonical coordinates and time, astronomy, sea-state
  synthesis, CPU/GPU wave hazards, vessel hydrostatics and motion, sail and
  rudder behaviour, collision and walkable surfaces, wake policy, terrain
  anchoring, camera composition, adaptive resolution, and render-source
  invariants;
- visual tools provide controlled contact sheets, component ladders, category
  probes, hull and rig audits, terrain captures, and reset/warm-up paths;
- CPU spans, presented-frame cadence, asynchronous GPU timer queries,
  full-frame GPU-fenced benchmarks, cross-revision campaigns, and host thermal
  telemetry are available;
- render resources generally have explicit `dispose()` ownership;
- developer panels are dynamically imported and kept out of the normal entry
  chunk until opened.

Approximate implementation sizes at the baseline:

| Area | Size |
|---|---:|
| `src/main.ts` | 5,226 lines |
| `src/scene/Ocean.ts` | 4,554 lines |
| `src/vessel/schooner/rig.ts` | 3,613 lines |
| `src/scene/shaders/lib.ts` | 2,130 lines |
| `src/vessel/schooner/shipGeometry.ts` | 2,026 lines |
| `src/scene/TimeOfDay.ts` | 1,755 lines |
| `src/vessel/schooner/rigGeometry.ts` | 1,557 lines |
| `src/scene/CrestSpray.ts` | 1,238 lines |
| `src/scene/FoamField.ts` | 1,194 lines |
| `src/vessel/BuoyantBody.ts` | 1,154 lines |
| `src/scene/Waves.ts` | 1,135 lines |
| Non-generated `src/` plus `tests/` TypeScript | about 95,800 lines |

Line count is not itself a defect. It establishes that this is not a thin
Three.js scene with a few game behaviours attached. It is a substantial custom
simulation, procedural-content, rendering, and verification runtime.

---

## 4. Strengths and invariants that consolidation must preserve

Any future design should begin by treating the following as assets, not legacy
obstacles.

### 4.1 One canonical planetary state

`PlanetaryWorld` owns ECEF position, tangent velocity, transported frame, and
UTC. Latitude, longitude, navigation telemetry, astronomy, render-space
directions, and local encounter velocity are derived. The renderer and vessel
integrators do not retain a second planetary position or navigation velocity.

Force-integrated schooner motion commits each fixed horizontal step back into
canonical ECEF state through `advanceTangentMotionStep()`. Vessel yaw remains a
vessel orientation; course over ground remains a property of canonical
velocity. This distinction remains valid at zero speed and under sideslip.

### 4.2 One explicit Earth-to-render boundary

`WorldRenderAdapter` is the Earth-scale-to-Three.js projection boundary. The
rendered vessel remains near the origin and ECEF positions do not go to the
GPU.

Anchored terrain extends this rule rather than bypassing it: tile vertices stay
small and tile-local, while CPU-side double-precision subtraction and one
matrix per tile place them relative to the current transported frame. The same
boundary supports the vessel-centred ocean and land hundreds of kilometres
away.

### 4.3 Deliberately distinct time and distance domains

The runtime distinguishes:

- raw real elapsed time for advancing the canonical astronomical clock;
- bounded presentation time for visible motion and interactive physics;
- a fixed 240 Hz vessel-physics grid;
- wave phase time advanced on that physics grid;
- ordinary wind time, with substep gust samples evaluated as a pure function;
- a separate voyage-distance compression applied to global geodesic travel;
- cloud presentation time and slower cache-generation cadence;
- authored crew-work durations converted into the interactive control scale.

These distinctions prevent a resumed tab, a lighting scrub, or a shortened
world day from making the hull encounter thirty times as many waves or inject a
destructive physics step.

### 4.4 One shared sea surface and one contact instant

`WaveField` is the definition of the resolved sea surface. Its bounded phase
representation and component tables are shared with the GPU. CPU sampling
drives buoyancy and hull contact; GPU evaluation drives displacement and
surface shading. Phase continuity is preserved during sea-state transitions.

The active vessel advances the wave field inside fixed physical substeps. The
completed hull contacts, wake-source condensation, foam, spray, ocean, and GPU
surface all consume the resulting instant. A future architecture may move the
authority, but it must preserve temporal and spatial parity.

### 4.5 A narrow active-vessel boundary and a reusable flotation core

`Vessel` gives the runtime one active-vessel surface. `BuoyantBody` contains the
shared fixed-step heave, pitch, and roll integration, while vessel adapters
supply hull-specific stations, mass properties, damping, and presentation.
The raft remains pinned by golden tests through the same generic core used by
the schooner.

`HullWaterContact` publishes a stable, allocation-free, read-only graph after
each contact evaluation. Buoyancy, resistance, diagnostics, and wake-source
extraction read the same resolved cuts instead of reconstructing independent
waterlines.

### 4.6 Geometry is a shared source of physical and interactive truth

The procedural schooner is not a render asset accompanied by hand-maintained
physics proxies. Hull sections feed geometry, displacement, mass, hydrostatics,
and contact stations. Rig nodes feed visible spars and sails, sail area,
centres of effort, aerodynamic normals, control limits, and rig-clearance
tests. Deck and fitting descriptions feed visible geometry, collision, and
walkable surfaces.

This shared-source policy has high preservation value. A future asset or editor
pipeline must reproduce the same relationship or explicitly choose a different
authority model.

### 4.7 One world-wind authority with explicit mean and gust branches

The sea state owns the mean wind. `WorldWind` owns deterministic instantaneous
gusts and direction wander. Sea presentation uses the mean; sail forces and
wind cues use the instantaneous branch deliberately. Substep sampling is pure
in wind time, preserving reproducibility and caller-rate invariance.

### 4.8 One-way coupling from physics into wake presentation

`WakeSources` condenses the completed hull-contact graph into stable stern,
bow, and waterline products. Wake policy resolves presentation gains from
those products, speed through water, wind, and ambient whitewater. Foam,
ocean shading, the wet-hull band, and bow-wave cues consume the result.

There is no reverse path from wake presentation into wave evaluation,
buoyancy, vessel forces, canonical motion, or the physical sea state. That
directionality is an important boundary.

### 4.9 One camera-independent world-light source

`WorldRadianceSource` produces one camera-independent HDR environment.
`WorldLighting` derives diffuse L2 spherical harmonics and a specular PMREM
from the same source and publishes them as one generation.
`WorldPbrMaterial` gives ordinary solid surfaces one material adapter for that
light. The vessel and terrain share it; the specialised sky and ocean retain
their own materials.

The source, paired publication, and material policy prevent object-specific
ambient gains from becoming competing descriptions of the world.

### 4.10 Quality changes protect physical identity

Desktop and mobile profiles may change mesh density, normal-detail octaves,
cloud detail, cloud-cache storage, foam resolution, spray capacity, and pixel
ratio. They retain the same wave-component budget, so display quality does not
silently change the sea the vessel feels.

Adaptive resolution is trial-based: a lower cap is retained only when it
recovers the frame budget or produces a material improvement. Resolution is
not repeatedly sacrificed when the measured bottleneck is insensitive to it.

### 4.11 Diagnostics and evidence are first-class

The project can step deterministically, reset and warm persistent fields,
freeze presentation, select exact sea/camera/time states, inspect individual
render categories, record physical matrices, and measure GPU and wall-cadence
behaviour. Visual decisions and failed approaches are supported by concrete
captures and measurements rather than only by recollection.

Consolidation should narrow diagnostic authority and make evidence cheaper to
maintain without losing this power.

---

## 5. Problem inventory

The problems below overlap. They are separated to expose design questions, not
to imply that each deserves an independent abstraction.

### P1. The composition root is the application runtime and evidence host

#### Observed condition

`src/main.ts` constructs the renderer and every production subsystem, parses
runtime and benchmark query parameters, selects quality and depth modes, owns
global browser state, wires vessel motion into canonical world motion, connects
sailing controls and rig presentation, resolves wake policy, derives and fans
out lighting, sequences simulation, prepares the ocean, controls render passes,
manages adaptive resolution, dynamically loads panels, defines `SimHandle`,
implements benchmark and capture routines, mounts experimental terrain, resets
the application, and disposes it.

The 366-line `stepSimulation()` function is the authoritative frame
transaction. More than two thousand additional lines in the same module serve
profiling, component probes, visual sheets, URL-driven benchmarks, and
alternative execution modes.

#### Why it matters

Assembly, orchestration, browser hosting, diagnostic authority, and evidence
scenarios change for different reasons but share one module and one lexical
state space. A subsystem can be locally well designed while its correct place
in the application remains a comment and a call position.

The entry module is difficult to exercise as a unit. The pure domains have
strong tests, while the real integrated frame exists inside a DOM/WebGL module
whose construction has already selected hardware policy, query modes, UI, and
global event handlers.

#### General direction

A future design should distinguish application assembly, runtime
orchestration, render orchestration, diagnostics, and evidence scenarios. It
should do so with the smallest useful set of boundaries rather than turning
ordinary construction into a framework.

### P2. Frame correctness depends on nested mutation and side-effect knowledge

#### Observed condition

The top-level frame order is explicit in comments, but important authority is
nested inside calls:

- `activeVessel.advancePhysics()` may run horizontal fixed steps, evaluate
  resistance and sail forces, advance controls, update `BuoyantBody`, advance
  `WaveField`, and commit global motion through a callback into
  `PlanetaryWorld`;
- `WakeSources.update()` is valid only after the body has published its final
  contact instant;
- `derivePresentationLighting()` mutates astronomy, render-adapter, cloud, wind,
  and `TimeOfDay` state;
- `WorldLighting.update()` must run after `SkySystem.update()` has published
  the uniforms representing the visible sky;
- foam update swaps persistent render targets, so the ocean must rebind the
  current textures before drawing;
- rig geometry must refresh inside the simulation step because deterministic
  capture loops call `stepSimulation()` and `renderFrame()` directly;
- reset and warm-up paths intentionally reproduce selected parts of the normal
  transaction with different cadence and blocking behaviour.

`VesselUpdateContext` is a stable mutable object used for both physical and
presentation phases. Some of its lighting fields are refreshed between those
phases; the type does not distinguish which fields are valid at which point.

#### Why it matters

Correctness requires knowledge of side effects below the level where ordering
is expressed. An alternate loop, replay system, save/load path, automated
capture, or new gameplay host must reproduce the same transaction without a
machine-readable account of its phases and products.

The strong fixed-step integrators do not by themselves make the application
frame transactional. A call that appears to update one domain may publish
state in the canonical world, the wave field, shared contacts, and control
channels.

#### General direction

The future design should state the frame as named phases or another explicit
transaction model, define which system may mutate each product during each
phase, and distinguish physical inputs from presentation inputs. The answer
may still use direct calls and mutable scratch objects; the requirement is
visible authority, not immutability for its own sake.

### P3. Clock and distance policy is correct but distributed

#### Observed condition

Time and distance rules live across `main.ts`, `PlanetaryWorld`, `WorldClock`,
`PresentationClock`, `WorldWind`, `WaveField`, `SkySystem`,
`SailingControls`, the vessel integrators, foam, camera controllers, and cache
schedulers.

Some domains own clocks. Others consume a delta, use a pure evaluation time,
apply a fixed conversion, retain an accumulator, or intentionally discard an
emergency remainder. The relationship among astronomical acceleration,
voyage-distance compression, ordinary encounter physics, cloud motion, crew
work, exposure adaptation, and diagnostic freeze controls is documented in
several local comments rather than represented by one runtime policy.

#### Why it matters

The code has multiple valid meanings for “seconds.” Passing the wrong one can
produce a plausible result: a sail still lowers, a cloud still moves, and a
ship still travels, only at the wrong relationship to the rest of the world.
These failures are difficult to detect visually and can survive ordinary type
checking.

Future replay, offline progress, save-state versioning, multiplayer, or
authoring timelines would each need a precise account of which clocks are
stored, derived, paused, scaled, or reconstructed.

#### General direction

A future design should produce a clock-and-distance responsibility map with
named domain deltas and explicit conversion policy. This need not mean a
single universal clock; the existing separation is valuable. It means that a
consumer should not infer a delta's semantics from its call site.

### P4. The environmental frame exists conceptually but not as a data product

#### Observed condition

Environmental state is distributed among:

- canonical world and astronomy state;
- mutable `TimeOfDay` directions, colours, radiances, exposure, twilight,
  cloud transmission, and sky harmonics;
- `SkySystem` uniforms, cache textures, cloud-field state, and celestial
  orientation;
- `WorldLighting` SH coefficients, PMREM texture, and generation;
- `WorldWind` mean and instantaneous values;
- sea-state, wave, water-optics, and whitewater values;
- developer-panel presentation trims.

`main.ts` gathers and copies those values into Three.js lights, renderer
exposure, the active vessel, ocean, spray, stars, world materials, diagnostics,
and audio. Some consumers receive a domain object, some individual scalars,
some mutable Three.js vectors, some shared uniform objects, and some values
through setters.

#### Why it matters

There is no single answer to “what environment did this frame render?” A
consumer cannot tell from the interface whether a reference is stable for the
frame, whether it may observe a mid-frame mutation, whether a value is physical
or presentation-adjusted, or whether it is safe to serialize for replay and
evidence.

Weather, terrain atmosphere, interior lighting, local light probes, and future
world objects all need coherent environmental inputs. Adding them through more
fan-out increases the number of combinations the coordinator must keep aligned.

#### General direction

The future design should identify one or more read-only environmental frame
products with clear producers, units, validity, and quality semantics. It
should separate canonical inputs, derived physical environment, presentation
adaptation, and diagnostic overrides without forcing unrelated data into one
large bag.

### P5. The cloud model has several execution representations

#### Observed condition

The cloud field participates in three related implementations:

1. GLSL contains the reference live volumetric march and the shared density,
   lighting, and transmittance functions.
2. `CloudDome` bakes colour-independent volumetric integrals into a sparse,
   paged equirectangular cache and relights that cache per frame.
3. `TimeOfDay` contains a CPU port used for low-frequency radiance means,
   world-lighting input, and direct Sun/Moon transmission.

The GPU bake uses the selected shader quality, including a 192-step view march
in the production profiles. The CPU mirror deliberately uses a much smaller
mean-fidelity traverse. Source tests compare important constants and structural
rules, but TypeScript and GLSL remain independently maintained algorithms.

The visible sky, star occlusion, world-light source, direct lights, and water
reflection do not all consume the same representation. They consume different
products intended to describe the same cloud field at different angular and
temporal fidelity.

#### Why it matters

This is a legitimate approximation architecture, but its error contract is not
complete. Constant parity does not prove semantic parity after a density,
lighting, erosion, cache, or quality change. A mismatch can remain
plausible-looking while the hull, water, stars, and visible dome disagree about
the cloud above them.

The selected quality profile can change the GPU field without changing the CPU
mirror in the same way. The architecture needs to say which consumers require
identity, which require shared structure, and which accept a measured
low-frequency approximation.

#### General direction

A future design should define “one cloud model” as an explicit family of
representations with named fidelity and measured error bounds. Shared or
generated definitions, GPU-produced summaries, offline validation, or a
smaller declared CPU approximation are all possible directions. The important
requirement is that agreement be a contract rather than a source-code
coincidence.

### P6. Shader and material organisation relies on weakly typed source surgery

#### Observed condition

Large GLSL programs live inside TypeScript template strings.
`src/scene/shaders/lib.ts` supplies shared sky and wave blocks;
`Ocean.ts`, `SkySystem`, `CloudDome`, `StarField`, `WorldRadianceSource`,
`FoamField`, `CrestSpray`, and `OceanTemporalResolve` contain additional shader
sources.

`WorldPbrMaterial` centralises the project's changes to Three.js physical
materials, while terrain and other consumers chain further
`onBeforeCompile` edits. The display transform modifies Three.js shader chunks
globally. Program-cache keys, injection anchors, defines, render-state settings,
and shared uniform object identity are all part of correctness.

Sky uniforms are exposed as `Record<string, THREE.IUniform>` and shared with the
ocean, stars, cloud cache, radiance LUT, and world-light source. Ocean profiling
and diagnostic modes create many compile-time variants from one material.

#### Why it matters

TypeScript does not understand GLSL syntax, declarations, variant interfaces,
uniform types, Three.js chunk compatibility, or injection order. Source-regex
tests defend important known hazards but do not compile every production
variant or prove interface compatibility on target browsers.

The broad shared uniform bag preserves live agreement at the cost of weak
ownership. A consumer receives more state than it needs, and the API is a
mutable dictionary whose effective schema is spread across shader text.

#### General direction

The future design should establish a shader-source, variant, and interface
strategy. Possible directions include generated typed bindings, explicit
uniform groups, build-time WebGL compilation, smaller shader modules, a
material graph, or engine-native materials. Runtime pass count and source
organisation should be decided separately: one final ocean shader may remain
the right performance choice even if its development model changes.

### P7. `Ocean` is the largest convergence point in the presentation runtime

#### Observed condition

`Ocean.ts` owns or participates in:

- radial mesh construction and geometry LOD;
- vertex wave displacement and residual per-fragment wave evaluation;
- unresolved normal detail and its cached representations;
- wave self-occlusion, reflection, Fresnel, sparkle, and water-body optics;
- sky-radiance LUT and cloud-aware environment sampling;
- persistent ambient foam and hull-wake channels;
- bow pressure-front and Kelvin-wake presentation;
- hull wetness, vessel sky/mirror occlusion, and direct shadow reception;
- sun, moon, and vessel-lamp response;
- salt haze and crest-spray coupling;
- far-field whitecap coverage and atmospheric haze;
- interior stencil rejection;
- temporal jitter metadata and diagnostic category modes;
- desktop/mobile compile policy and numerous live A/B controls.

The constructor calculates render-mesh LOD spacing and writes it into
`WaveField`, because render resolution determines which spectral components
belong in vertices and which remain residual. The class exposes dozens of
setters that allow the coordinator and diagnostics to mutate individual parts
of the material contract.

#### Why it matters

These effects genuinely interact in the final water pixel, so mechanically
splitting the file would not eliminate their coupling. The issue is that
physical-sea representation, render resolution, optics, environment, local
interaction, wake presentation, fixed-function masking, quality, diagnostics,
and resource ownership meet at one class and one large shader family.

A local change can therefore reopen a wide visual and performance surface.
The reverse write into `WaveField` also shows that no higher-level object owns
the cross-system ocean resolution plan.

#### General direction

The future design should define stable contracts inside “the ocean” before
deciding where code or passes move. At minimum it should distinguish:

- physical sea and wave evaluation;
- spatial/frequency resolution policy;
- renderable surface representation;
- water optical response;
- environmental inputs;
- persistent surface phenomena;
- vessel-local interactions and masks;
- temporal reconstruction;
- quality and diagnostic variants.

Several of these may still compile into one shader. Conceptual ownership and
GPU pass decomposition are different decisions.

### P8. Render-pass and GPU-state dependencies are implicit

#### Observed condition

One presented frame can involve:

- foam ping-pong simulation;
- sparse cloud-cache work and a sky-radiance LUT;
- a world-radiance source render, PMREM generation, and asynchronous or
  synchronous readback;
- directional and point-light shadow maps;
- interior stencil writes followed by ocean stencil rejection;
- the main sky, stars, ocean, terrain, vessel, and spray draws;
- optional ocean colour, motion metadata, history, and resolve targets;
- diagnostic render targets and framebuffer readbacks;
- cumulative-prefix GPU timer queries.

Correctness depends on render order, layers, visibility changes, stencil and
depth state, render-target restoration, pixel-pack-buffer state, material
defines, cache generations, and whether execution will yield to the browser's
microtask and presentation queues.

Some passes are explicit method calls, some occur inside Three.js rendering,
some are installed as object callbacks, and synthetic terrain enters through a
render-time hook. `renderFrame()` is the closest thing to a render graph, but
it does not own every render operation performed during `stepSimulation()`.

#### Why it matters

The application contains a multi-pass renderer without one structural account
of its passes, resources, dependencies, and state restoration. Alternative
capture and benchmark paths exercise the same GPU through different scheduling
rules, making a correct production frame insufficient evidence that an
evidence frame is correct.

Adding terrain occlusion, interior portals, weather volumes, reflections, or
new post-processing increases the chance of a pass reading the wrong
generation or inheriting state from another path.

#### General direction

A future design should make render operations and their dependencies explicit
enough to validate ordering and resource lifetimes. That may be a small
project-specific pass scheduler, an engine render graph, or documented pass
objects with tests. The need is an authoritative model, not necessarily a
general-purpose renderer framework.

### P9. Spatial-frame contracts are numerous and mostly conventional

#### Observed condition

The application uses several valid spaces:

- ECEF world coordinates and transported tangent bases;
- geodetic latitude/longitude and compass headings;
- vessel-centred render coordinates;
- vessel/body-local coordinates;
- hull station coordinates and placed deck coordinates;
- wave parameter/seed space and displaced world space;
- observer-centred ocean-mesh coordinates;
- persistent foam-level grids with independent origins;
- camera and screen coordinates;
- terrain tile-local coordinates and anchored render matrices.

Conversions are carefully documented and heavily tested. They are generally
represented with ordinary numbers, object shapes, and `THREE.Vector*` values,
however, so frame identity lives in names, comments, and call structure rather
than the type system.

Wake registration is a representative example: resolved world-space hull cuts
must be inverted through Gerstner displacement before becoming foam-field
sources. Camera recentering, wave origins, wake grain, and observer scrolling
then use related but non-identical offsets.

#### Why it matters

The number of spatial domains makes sign, handedness, origin, and displaced
versus parameter-space mistakes likely. Such mistakes often produce a visible
effect in approximately the right place, which makes them expensive to
diagnose.

Terrain, currents, encounters, navigation instruments, interior portals, and
future multiple moving subjects all increase the number of conversions at the
runtime boundary.

#### General direction

The future design should publish a spatial-frame vocabulary and place
conversions at explicit seams. Branded types, dedicated records, or naming and
module rules may be sufficient; wrapping every vector in an allocation-heavy
class is not required. The goal is to make an invalid cross-frame connection
hard to express and easy to review.

### P10. Quality and capability policy is spread across subsystems

#### Observed condition

Initial viewport dimensions select desktop or mobile presets. That selection
affects ocean mesh density, detail octaves, cloud noise and sun steps, cache
dimensions and slot capacity, foam resolution, spray capacity, and initial
pixel-ratio limits. Adaptive resolution changes pixel ratio independently.

Additional query and live controls select cloud march counts, conventional or
experimental depth modes, temporal ocean resolve, shader profiling variants,
and diagnostic feature switches. Some quality differences are visual; some
change memory; some change shader structure; some change the approximation used
by a CPU/GPU shared model. Terrain also carries a platform-dependent depth
strategy question.

The physical wave-component budget is protected, and several screen-space
effects compensate for adaptive pixel ratio. There is no complete policy that
states all protected invariants and permitted approximations across systems.

#### Why it matters

“Mobile,” “small screen,” “capability,” “performance mode,” “experimental
renderer,” and “current adaptive state” are different concepts. Treating them
as one profile makes it difficult to explain why a quality changed, whether it
may change at runtime, and which consumers must follow it.

A lower resolution can also expose a different bottleneck or alter a
screen-space artistic calibration without reducing the dominant fixed-size
work.

#### General direction

A future design should define quality through protected invariants and named
approximation budgets, separate initial capability selection from user intent
and runtime adaptation, and identify which settings require coordinated changes
across CPU, GPU, caches, and evidence.

### P11. Diagnostic access is explicit but too broad

#### Observed condition

`SimHandle` is an explicit interface, but it is roughly 220 lines and exposes
the concrete renderer, scene, camera system, vessel, ocean, waves, wind, world,
sky, stars, lighting, foam, spray, wake sources, and sea-state controller in
addition to many commands, live policy objects, setters, benchmarks, captures,
and reset operations.

At least twenty debug modules import the type from `main.ts`. Several tools
mutate concrete uniforms or runtime objects directly. Development builds also
publish a broad `window.__drift` object. The buoyancy lab substitutes its own
animation loop; capture tools call the simulation and renderer synchronously;
performance URLs start unattended workflows from the entry module.

The tabbed developer-tools shell unifies presentation of the tools, but it does
not narrow their runtime authority.

#### Why it matters

The diagnostic layer depends on current runtime topology rather than only the
behaviours it needs to control or observe. Moving an implementation boundary
therefore risks breaking evidence tools even when product behaviour is
unchanged.

Broad authority also makes a diagnostic capable of creating states production
cannot reach, retaining mutable references across frames, or bypassing the
transaction whose behaviour it intends to measure.

#### General direction

The future design should retain deterministic stepping, reset, inspection,
capture, and low-level investigation while separating:

- stable commands;
- read-only frame and telemetry products;
- evidence-scenario orchestration;
- exceptional renderer/debug access.

The diagnostic contract should be owned independently of the browser entry
module, with low-level access explicit and intentionally unstable where it is
truly needed.

### P12. Configuration categories are interleaved

#### Observed condition

Configuration appears as:

- canonical sea-state records and wind parameters;
- hull, mass, hydrostatic, resistance, and sail-aero coefficients;
- crew-work and control-rate policy;
- ocean optics, lighting constants, and colour-pipeline choices;
- desktop/mobile quality records and cache dimensions;
- fixed shader constants and duplicated CPU/GLSL constants;
- live developer-panel controls;
- URL-selected experiments and benchmark modes;
- feature-specific policy objects such as wake gates;
- accepted artistic values retained beside their measurement rationale.

Many individual values are well documented. The runtime has no common
taxonomy for whether a value describes world state, physical model, gameplay
rule, presentation mapping, hardware budget, experimental branch, or temporary
diagnostic override.

#### Why it matters

A requested change can enter at several layers and produce similar immediate
results with different long-term meaning. For example, a darker sea might be a
water-optics change, an environment-light change, a tone-map change, a
quality approximation, or an A/B-only multiplier.

Save data, replay, presets, user settings, automated evidence, and an eventual
editor each need to know which values are authoritative and which are derived
or transient.

#### General direction

The future design should define configuration layers and allowed directions of
influence. It need not centralise every constant. It should make the semantic
category, owner, persistence, and validation of an exposed value apparent.

### P13. Procedural single-source content has a large change surface

#### Observed condition

The schooner is generated from an interconnected set of hull, backbone, mass,
deck, fittings, interior, rig, sail, and shipwright modules. The same data feeds
many valuable consumers, but the source-of-truth graph is not represented as a
single schema or build product.

`rig.ts`, `rigGeometry.ts`, and `shipGeometry.ts` contain substantial authored
geometry and construction logic. Live sail trim temporarily applies derived
node positions, evaluates aero from the same corners, and refreshes mutable
geometry. Tests and evidence check many pairwise agreements: geometry against
hydrostatics, deck against walking, rope against attachment, trim against
rigging, cloth against aero, and interior against traversal.

#### Why it matters

The shared-source policy prevents silent proxy drift, but a structural change
can affect rendering, physics, collision, mass, controls, camera framing, and
evidence. The required validation is distributed across modules and specialised
suites.

An editor, imported asset, LOD pipeline, damage system, multiple vessel types,
or runtime persistence cannot be added by treating the current procedural
output as only a mesh. The semantic construction data is part of the game.

#### General direction

A future architecture should make the procedural content graph and its derived
products explicit. It should decide which authored facts form a stable schema,
which derivations happen at build time or runtime, and how a consumer declares
its dependency. Consolidation must preserve the one-truth benefits rather than
splitting the vessel into independently maintained render, physics, and
collision assets.

### P14. Verification is broad but incomplete at integrated boundaries

#### Observed condition

The project has strong pure tests, physical integration suites, committed
evidence, render-source guards, live GPU profiling, deterministic captures,
cross-revision benchmarks, and thermal diagnostics.

Known gaps remain:

- production shader variants are not comprehensively compiled during the
  normal type/test suite;
- source-regex tests prove selected textual properties rather than shader
  semantics;
- CPU/GPU model parity is only partially machine-checked;
- many accepted visual states require manual judgement of generated sheets;
- browser, GPU, device, visibility, and compositor behaviour remain difficult
  to reproduce in numerical tests;
- the full physical suite is intentionally slow and runs on a different cadence
  from the default suite;
- performance conclusions require controlled backing-store, GPU, contention,
  and thermal conditions;
- some evidence paths execute the runtime synchronously and therefore exercise
  different scheduling behaviour from a presented frame.

#### Why it matters

A green numerical suite can coexist with a shader compile failure, stale
environment generation, visual regression, temporal instability, incorrect
capture, or unacceptable GPU cost. Manual review remains necessary, but the
state matrix spans time of day, sea, wind, sail state, heading, camera, quality,
terrain, interior/exterior view, and platform.

The verification system is also an architectural client. A new runtime that
cannot reproduce deterministic steps and named evidence states would discard
one of the project's strongest assets.

#### General direction

The future design should map each boundary to the appropriate evidence:

- pure numerical tests;
- fixed-step integration and committed matrices;
- shader compilation and interface checks;
- deterministic render captures and semantic image metrics;
- temporal-stability measurements;
- GPU and wall-cadence timing;
- target-device acceptance runs;
- human visual decisions with durable provenance.

The aim is not to automate taste. It is to keep accepted properties from being
accidentally reopened during unrelated work.

### P15. Current truth is distributed across specifications and handovers

#### Observed condition

The repository has a subject-organised documentation index, specifications,
architecture audits, ADRs, project plans, round reports, handover logs,
performance reports, evidence records, and historical prompts.

The folder hierarchy is clear, but semantic authority is not uniformly clear.
Some planning documents describe implemented systems as deferred; long handover
logs place an early status near the top and later corrections near the bottom;
source comments preserve findings, failed approaches, measurements, and final
policy in the same implementation file.

The most reliable answer to “what is true?” may require reconciling a canonical
specification, a later handover section, source comments, tests, and current
code.

#### Why it matters

An architecture round must distinguish enduring product requirements from
implementation choices, experimental findings, and superseded state. Without a
short path to current truth, a redesign can preserve an obsolete constraint or
discard a product-defining invariant that lives only in forensic context.

The cost also affects ordinary maintenance: rich history is valuable, but it
raises the scan cost of already substantial modules and documents.

#### General direction

The future vision should establish a document hierarchy for:

- current product and experience requirements;
- current architectural contracts and source-of-truth rules;
- accepted decisions and rationale;
- verification evidence and regeneration instructions;
- active plans and open questions;
- historical investigations and superseded handovers.

History should remain available, while current truth should have one short and
unambiguous route.

---

## 6. What is not currently demonstrated to be a problem

A later design round should avoid treating the following as defects without
additional evidence.

### 6.1 The absence of an ECS

The application has one active vessel, one walking player, a small number of
large environmental systems, and experimental terrain tiles. Nothing in the
current evidence shows that entity iteration or component composition is the
limiting problem.

### 6.2 Classes and direct method calls

The class-based subsystems generally have clear local ownership. Replacing
direct calls with events, dependency injection, or a service framework would
not by itself solve frame authority, shared mutable products, shader coupling,
or render-state sequencing.

### 6.3 Procedural construction

The procedural hull, rig, deck, and terrain fixtures provide deterministic,
inspectable, shared sources for geometry and physical truth. An asset pipeline
may become useful, but imported meshes are not automatically a cleaner source
of hydrostatics, collision, aero, or attachment topology.

### 6.4 Custom rendering itself

The ocean, clouds, world lighting, camera, planetary frame, and vessel/water
coupling contain distinctive and validated behaviour. Stock components are an
improvement only if the product accepts their behaviour or the migration can
preserve the project's defining results.

### 6.5 File size in isolation

Several files are large because the underlying model and its rationale are
substantial. Mechanical splitting can increase coupling by moving one concept
across more files without defining a better contract.

### 6.6 Performance as the sole driver

Performance is measured and several expensive paths are known. Architecture
may improve cost, but a fast design that weakens determinism, visual identity,
or simulation/render agreement is not thereby better.

### 6.7 The canonical world, shared wave field, or contact model

The ECEF/geodesic world, Earth-to-render boundary, single wave field, and
shared hull-contact graph are among the cleanest parts of the project. A new
runtime may port or wrap them, but there is no current architectural case for
discarding their concepts.

### 6.8 The amount of testing and evidence

The verification surface has real maintenance cost, but reducing confidence is
not consolidation. The useful question is how evidence attaches to stable
contracts and how expensive scenarios are selected, regenerated, and retained.

---

## 7. The actual decision space

“Consolidation” and “rewrite” are not one binary choice. A later vision round
should compare at least these levels of intervention:

1. **Clarify and consolidate in place.**

   Preserve Three.js, the current physical models, and procedural content while
   extracting runtime phases, environmental products, spatial/time contracts,
   render operations, configuration layers, and diagnostic capabilities.

2. **Rebuild the runtime backbone within the current renderer.**

   Keep Three.js materials and scene systems while introducing a new
   application runtime, frame transaction, render-pass model, and evidence host
   around the existing domain implementations.

3. **Replace selected infrastructure.**

   Keep the world, vessel, wave, camera, and content semantics while replacing
   particular shader, material, render-graph, asset, terrain, or tooling
   infrastructure.

4. **Rebuild or migrate the presentation runtime.**

   Treat the current application and its evidence as an executable
   specification and port validated behaviour into a different renderer or a
   full game engine, deciding deliberately which custom systems remain
   authoritative.

These options can be staged and combined. The important comparison is not
“rewrite versus no rewrite,” but which responsibilities the project wants to
continue owning and which proof can falsify each proposed direction early.

---

## 8. Questions a future architecture / rewrite-vision round should answer

### Product and platform

- Is browser delivery a product requirement, a development surface, or one
  target among several?
- Which desktop, mobile, browser, and GPU combinations define the intended
  experience?
- Is one active vessel the enduring product shape, or must the runtime support
  multiple vessels, encounters, crew, wildlife, and independently moving
  subjects?
- How much of the current procedural-content model should remain code-authored,
  and where is an editor or asset pipeline valuable?
- Is the target realistic environmental fidelity, a controlled atmospheric
  style, or a particular authored look independent of physical realism?
- Which terrain, coastline, weather, interior, navigation, and gameplay systems
  are close enough to constrain the architecture?

### Runtime ownership

- What owns the application lifetime and the authoritative frame transaction?
- What are the named simulation, derivation, presentation, and render phases?
- What is the single owner of each clock, accumulator, and distance scale?
- Who advances the wave field, and how is its completed instant published?
- How does vessel fixed-step motion commit to canonical planetary state without
  making the entry module the bridge implementation?
- Which products are stable for a frame, and which are live mutable services?
- What state is serializable for save, replay, offline progression, or evidence?

### Data and coordinate contracts

- What constitutes the environmental state for one frame?
- Which spatial frames deserve explicit types or conversion APIs?
- How are physical state, presentation state, and diagnostic overrides kept
  distinct?
- Which procedural facts are canonical, and which geometry, physics, collision,
  and rendering products derive from them?
- How are versioned content and save data handled when procedural derivations
  change?

### Environment and rendering

- Is there one environment model evaluated in several places, or explicitly
  different models connected by measured approximation contracts?
- Which cloud products must be identical, and which may be low-frequency or
  delayed summaries?
- Should clouds, atmosphere, sky lighting, water reflection, shadows, and
  temporal reconstruction be project code or platform/engine services?
- What are the stable contracts inside the ocean shader?
- What render-pass and resource model covers foam, cloud cache, lighting,
  shadows, stencil, ocean temporal resolve, terrain, and captures?
- What is the shader source, interface typing, variant, and pre-runtime
  validation strategy?
- How does quality policy preserve physical and visual invariants across
  capability tiers and adaptive changes?

### Vessel, player, and world content

- Which schooner behaviours and dimensions are product-defining and must be
  reproduced exactly, perceptually, or only conceptually?
- Does shared procedural truth remain the primary authoring model for hull,
  rig, collision, mass, hydrostatics, and aero?
- How are additional vessel types, damage, cargo, flooding, or sail states
  represented without weakening the current source-of-truth guarantees?
- How should deck and interior traversal integrate with a general character
  controller, portals, and local lighting?
- Where do currents, weather, terrain streaming, and encounters enter canonical
  world state?

### Tooling and verification

- What deterministic stepping, reset, inspection, and capture capabilities
  must the runtime expose?
- Which diagnostic capabilities are stable product-like APIs and which are
  deliberately privileged internal access?
- How will shader/material variants be compiled and validated before runtime?
- How will accepted visual states be named, captured, compared, and retained?
- How will GPU cost, cadence, memory, and thermal behaviour be measured on
  target hardware?
- How will default, specialised, and evidence-generating tests attach to the
  proposed boundaries?
- How will existing evidence map onto a new architecture rather than being
  silently abandoned?

### Migration

- Can the change proceed as bounded vertical slices with a working application
  after each slice?
- What is the smallest slice that proves the proposed runtime and rendering
  model under real ocean, vessel, camera, and diagnostic load?
- Which comparison scenes and physical matrices decide whether a replacement
  is genuinely better?
- What is the rollback point if generic engine capability improves while the
  game's distinctive ocean, sailing, camera, or planetary behaviour regresses?
- Which current modules can serve unchanged behind new boundaries, and which
  assumptions make direct reuse misleading?

---

## 9. Suggested outputs of the later vision round

Without prescribing the resulting architecture, a useful design round would
produce:

1. **A responsibility and state map**

   Every authoritative state, clock, accumulator, derived frame product,
   quality decision, render resource, procedural source, and diagnostic
   capability has an explicit owner.

2. **A frame and render-flow design**

   Canonical update, fixed-step simulation, contact publication, environment
   derivation, presentation, GPU preparation, render passes, and evidence
   capture have explicit order and inputs.

3. **A data and spatial-contract design**

   Frame products, units, mutability, validity, coordinate spaces, conversion
   seams, and serialization rules are stated.

4. **A preservation ledger**

   Existing behaviours and evidence are classified as preserve exactly,
   preserve perceptually, replace deliberately, or discard.

5. **A procedural-content strategy**

   Canonical vessel and world content, derived products, editor/asset
   boundaries, versioning, and validation responsibilities are defined.

6. **An environment-model strategy**

   The relationship among CPU state, cached and live GPU evaluation, world
   lighting, sky, clouds, water, quality levels, and local enclosures is stated.

7. **A shader, material, and render-resource strategy**

   Source organisation, interface typing, build-time validation, variant
   management, pass ownership, lifetime, and engine/native boundaries are
   defined.

8. **A quality and capability strategy**

   Protected invariants, permitted approximations, device capabilities, user
   intent, adaptation, and experimental modes are separated.

9. **A diagnostics and verification strategy**

   Commands, telemetry, privileged access, tests, captures, metrics, GPU
   timing, target-device checks, and evidence retention map to the proposed
   boundaries.

10. **Two or more viable architecture options**

    Each option includes benefits, costs, risks, retained assets, discarded
    work, migration seams, and the responsibilities the project continues to
    own. The round compares alternatives rather than rationalising a
    preselected rewrite.

11. **A proof plan**

    A bounded vertical slice answers the highest-risk questions before a
    full-scale migration or refactor begins.

12. **Decision records**

    The selected direction and rejected alternatives are recorded separately
    from this problem statement.

---

## 10. Exit criteria for problem analysis

The architecture problem can be considered sufficiently understood when:

- all authoritative mutable state, clocks, accumulators, and distance scales
  are accounted for;
- the production frame, nested fixed-step transaction, render operations, and
  alternate evidence paths are mapped;
- every spatial conversion and persistent local origin has an explicit owner;
- each CPU/GPU/cached representation has a declared identity or approximation
  contract;
- the environment-to-consumer fan-out has a defined frame product;
- ocean responsibilities and render-resource dependencies have stable seams;
- procedural content sources and their derived consumers are mapped;
- quality invariants and permitted approximations are stated;
- diagnostic access and verification requirements are preserved intentionally;
- current product requirements are separated from implementation choices and
  historical investigations;
- at least two credible directions have been compared against the same product,
  technical, evidence, and migration criteria;
- the first proof slice can falsify the preferred direction without requiring
  the whole application to be rewritten.

---

## 11. Closing assessment

The present architecture should not be described as incoherent or poorly
designed. It contains unusually strong decisions:

- one planetary state and one Earth-to-render boundary;
- one physical sea surface shared by simulation and rendering;
- force-integrated vessel motion committed to canonical ECEF state;
- reusable buoyancy and stable hull-contact products;
- procedural geometry shared with physics, collision, and aero;
- deterministic wind, control, and evidence paths;
- one-way wake coupling;
- one camera-independent world-light source;
- deliberate quality invariants;
- extensive numerical, visual, and performance verification.

The architectural pressure comes from the scope the application itself owns:

- planetary state, astronomy, and accelerated travel;
- several time and coordinate domains;
- physical sea-state synthesis and CPU/GPU wave agreement;
- distributed six-degree vessel response across vertical and horizontal
  integrators;
- resistance, sailing forces, steering, and live rig geometry;
- procedural hull, rig, deck, interior, collision, and player traversal;
- volumetric clouds, cached sky evaluation, atmosphere, world lighting, stars,
  and colour management;
- ocean optics, reflection, whitewater, spray, shadows, wake, masking, and
  temporal reconstruction;
- anchored terrain and long-range depth policy;
- browser hosting, adaptive quality, diagnostics, captures, profiling, and
  cross-revision evidence.

That scope converges through a browser entry module, nested mutable frame
operations, shared uniform dictionaries, independently maintained CPU/GPU
models, implicit render-state sequencing, broad diagnostic handles, and a
small number of very large presentation and procedural-content modules.

The goal of consolidation is not to make the project “proper.” It already
contains serious domain architecture and strong evidence. The goal is to
decide which engine responsibilities belong to this game, give the ones that
remain explicit ownership and interfaces, and reduce the amount of unrelated
system knowledge required to make one correct change.
