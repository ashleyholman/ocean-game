# Developer guide

This was the project README for most of its life and is kept as the working
reference: how to run, build and test, the evidence exporters, the two camera
modes, the developer shell, the player interface behind `?player`, and a map of
the source tree. The front-page [README](../../README.md) is the short version.

## Requirements

Node 20.19+ (or 22.12+), and a browser with WebGL2.

## Documentation

Design specifications, project plans, implementation reports, and handovers are
organized by subject in the [documentation index](../README.md).

## Setup

```bash
npm install
```

## Run

```bash
npm run dev
```

Then open the printed URL (http://127.0.0.1:5173 by default).

## Build

```bash
npm run build
```

Type-checks with `tsc --noEmit` and writes a production bundle to `dist/`.
Preview the built output with:

```bash
npm run preview
```

## Type check only

```bash
npm run typecheck
```

## Tests

```bash
npm test
```

The numerical suite covers WGS84 conversions, official geodesic vectors, pole
and antimeridian crossings, transported-frame invariants, large-step
equivalence, clock separation, solar reference cases, LAST/date/teleport
controls, celestial orientation, snapshots, the render adapter, catalogue
provenance, and the sea-state model — spectral discretisation, exact
significant height, Pierson-Moskowitz limits, whitecap calibration against
Monahan, inverse-displacement residual, phase continuity across a sea-state
change, and the shader-source hazards that a GLSL template literal invites. It
also covers ship hydrostatics, roll and pitch decay, selected response cases,
single-wave encounter timing, and the integrity of both committed ship-response
matrices (including reciprocal-heading bounds for the stationary matrix), the
passive resistance surface, and force-integrated coast-down, sideslip and yaw
decay with caller-rate and voyage-compression invariance.

The ship's permanent zero-speed response matrix is a longer, intentional run:

```bash
npm run ship:response
```

It writes the deterministic JSON baseline to
`evidence/ship-response/zero-speed-baseline.json`. The path is stable so a
motion change can regenerate the file and preserve the resulting performance
change in the same Git commit. The ordinary test suite checks faster physical
invariants and selected response cases; it does not rewrite the baseline.

The deliberately small prescribed-speed encounter run is separate:

```bash
npm run ship:encounter
```

It writes `evidence/ship-response/encounter-frequency.json`, which checks head,
following, beam and quartering timing against the deep-water relation, and
`evidence/ship-response/prescribed-speed-baseline.json`, which records eight
headings through `CURRENT_MODERATE` at a prescribed 4 m/s. This is a tow-tank
diagnostic: it adds relative motion through the existing wave field, not sails,
steering, current or force-integrated forward speed.

The running game now uses that same encounter contract. A canonical 1 m/s
velocity encounters one metre of local water per real second, while a separate
30× voyage-time compression advances global ECEF position by 30 metres. Thus
long journeys fit the shortened world day without making the waves or hull act
as though the ship were travelling at 30 m/s. The ship remains at local render
`(0, 0)`, while passive hull resistance now force-integrates surge, sway and
yaw at 240 Hz and commits every step back to canonical ECEF velocity. Persistent
foam and airborne spray move through the vessel-following frame. Because no
current field exists yet, speed through water deliberately equals speed over
ground, but heading and course can differ through sideslip. Developer speed or
heading commands engage a captive tow; **Release tow** returns to passive
motion. There is still no sail drive, commanded rudder force, current or wake.

The passive force surface and its integrated decay record are separately
regenerable:

```bash
npm run ship:resistance
npm run ship:dynamics
npm run ship:dynamics:response
```

They write `evidence/ship-resistance/calm-water-baseline.json`,
`evidence/ship-dynamics/passive-horizontal-baseline.json` and
`evidence/ship-dynamics/wave-response-comparison.json`. The first is captive
force evidence; the second proves coast-down, sideslip/yaw decay, retained
captive tow, fixed-step caller invariance and 1×/30× voyage separation. The
third releases the integrated vessel from the previous 4 m/s captive condition
over the same eight `CURRENT_MODERATE` headings and records the response delta.

## Controls

There are two camera modes: a **cinematic** camera outside the active vessel,
and an **embodied** one aboard it.

| Input | Cinematic | Embodied |
|---|---|---|
| Pointer drag / one-finger drag | Orbit around the vessel | Mouse: look around. Touch: drag the right side to look |
| `WASD` / arrows, or left-side touch drag | — | Walk the deck |
| Mouse wheel / pinch | Scale, 12 m to 1.4 km | — |
| `V`, or double-tap open water | Change mode | Change mode |
| `Space`, or click/tap the sail or mast | Raise or lower the sail | — |
| `M` | Mute ambience | Mute ambience |

The original 12–1400 m scale and wheel response are the same for every vessel,
so close detail shots remain available even when the full rig cannot fit. The
assembled hull, masts, spars and sails publish a one-time framing envelope. At
one stable reference view, the camera uses that envelope to choose a vertical
track offset. The same offset is then used at every distance, so zoom follows
one straight line with one fixed pointing direction. The close range remains
unrestricted and may crop the rig, but its higher viewpoint looks onto the deck
instead of into the bottom of the hull.

Looking is grab-the-world in both modes, like a street-level panorama: drag
right and the scene follows your finger. The embodied view can turn a full
circle and look from 85 degrees down to 1 degree short of the zenith, so the
stars overhead are directly reachable. The sail is real geometry and blocks the
view when it is between you and what you are looking at; lowering it opens the
view again.

Panning away from the vessel is deliberately disabled, and there is no player
steering yet. Course is currently an explicit developer command.

A one-line hint appears shortly after load and fades away for good. Normal mode
has no permanent interface — no camera HUD, no marker on the vessel.

See `docs/camera/CAMERA_SYSTEM.md` for the architecture and the composition rules, and
`docs/camera/CAMERA_ROUND_REPORT.md` for what was measured.

## The player interface

`?player` opens the page with a **Controls** pill in the bottom-left corner and
nothing else. It was added late, to hand a link to someone who is not building
the thing and get their feedback without the confusing knobs; it is still a set
of knobs for the engine rather than a game interface. Five pages, sized for a
thumb, laid out as a panel on a desktop and as a bottom sheet on a phone:

- **Helm** — a compass card turning under a fixed lubber line, the standing
  course order as a brass diamond on it, and the rudder the helmsman is
  actually using; speed, apparent wind and point of sail. Giving a course is a
  *spoken order* through the same crew pipeline the developer panel uses.
- **Sea** — the playable sea states, named and described for a visitor, plus
  wind speed and the bearing the wind blows from.
- **Sky** — time of day, hold-the-sky-still, time of year, and the globe, with
  four open-water destinations for anyone who does not want to aim at a
  wireframe.
- **View** — outside or aboard, look speed, invert, and the two resets.
- **Perf** — frame rate, frame time, buffer resolution and whether the renderer
  is drawing below the screen's own resolution, with a **Copy this report**
  button for sending back.

`\` hides every scrap of interface, the same as it always has. The tow harness,
the manual heading override, the graphics trims and the labs are not hidden in
here — they are absent from this interface's sources entirely.

The ship opens on a beam reach with a course already ordered and someone at the
tiller; see `src/world/openingVoyage.ts`, which derives that situation from the
production sea rather than restating it.

## Developer tools

The full diagnostics are the default: the page opens with the **Debug** pill
and the development instrument panels. `?debug=<panel>` deep-links into one of
them, and `?player` swaps the whole shell for the player interface above.

Notable panels include:

- **World & lighting** — clickable `−1 m/s`, `+1 m/s`, **Stop**, and **Sail
  target** ship-speed controls with actual/target readouts; a continuous
  00:00–24:00 local apparent solar-time
  slider; a 365/366-day apparent-solar calendar slider with month markers that
  preserves solar time; an astronomical multiplier and Sun/Moon/stars freeze
  control (neither alters the separate 30× voyage scale, velocity, wind, waves
  or clouds); a draggable
  orthographic globe (click its visible surface to teleport while preserving
  local apparent solar time); a commanded true-heading control that also sets
  course while moving; exposure; and
  canonical ECEF position/velocity with derived latitude, longitude, height,
  course, UTC, calendar, LAST and Sun telemetry.
- **Camera** — the active mode; the cinematic scale and the distance it
  produces; head-stabilisation roll, pitch and heave follow fractions and their
  smoothing; transition duration; reset buttons for the cinematic composition,
  the embodied look and the head model; and a measured readout — distance,
  horizontal distance, altitude, orbit elevation, optical pitch, horizon
  placement, heave lag, field of view and near plane — all read back from what
  the controllers actually produced, so a clamp shows up instead of hiding
  behind the value that was asked for.
- **Scene inspection** — arms the next scene click, freezes its complete world
  and vessel-local ray plus first visible mesh/material/face hit, marks the hit,
  and publishes the immutable record in `#drift-browser-diagnostics`. Because
  the vessel-local values are captured immediately, the evidence remains valid
  while the ship continues to roll, pitch and translate. See the
  [scene inspection ray runbook](../project/SCENE_INSPECTION_RAYS.md).
- **Ocean laboratory** — the sea-state preset matrix, wind speed/direction/
  maturity/gustiness, independent primary and secondary swell (height, period,
  direction, spread, steepness, groupiness), surface detail, whitewater
  generation and persistence, transition duration, diagnostic phase-origin and
  wrap-boundary controls, and a readout of what the spectrum actually resolved
  to.
- **Buoyancy lab** — the stepped verification harness. It replaces the render
  loop with its own, so selecting it reloads the page.

**Hiding is not closing.** `Hide all` gives a clean, screenshot-ready frame
while every panel keeps its state, so reopening does not reset the world, the
sea state or the foam history. `Clean view` also hides the launcher chip;
<kbd>\\</kbd> toggles all chrome either way.

Each panel is a dynamic import, so none of this code exists in the production
entry chunk and opening one lab does not load the others.

### Direct links

These are bookmarks into the same UI, not a separate debug system:

| URL | Opens |
|---|---|
| (no parameter) | the developer shell, on its first panel |
| `?player` | the player interface instead of the developer shell |
| `?debug=1` | the World & lighting panel |
| `?debug=camera` | the Camera panel |
| `?debug=inspect` | the scene inspection ray recorder |
| `?debug=ocean` | the Ocean laboratory |
| `?debug=buoyancy` | the stepped buoyancy harness (exclusive mode) |
| `?terrain=synthetic&fixture=peak&range=40&bearing=-48&haze=100&depth=reversed&debug=terrain` | unmistakable synthetic land with live distance and terrain-only haze sliders; camera range follows the land automatically |
| `?capturePort=5200` | send evidence captures to an alternative capture server |

### Evidence capture

```bash
node tools/capture-server.mjs evidence 5199
```

Then drive `window.__lab` from the console at `?debug=buoyancy`. Artefacts are
written under `evidence/`. Regenerate the machine-readable preset matrix with:

```bash
npx vite-node tools/export-presets.ts
```

## Layout

```
src/
  main.ts                    bootstrap, render loop, resize, adaptive resolution
  world/
    PlanetaryWorld.ts        canonical ECEF state, separate clock/physics advances
    wgs84.ts                 WGS84 ECEF/geodetic conversion and surface bases
    geodesic.ts              isolated GeographicLib direct propagation
    frameTransport.ts        exact geodesic-basis parallel transport
    clock.ts                 astronomical and presentation clock APIs
    navigation.ts            derived navigation telemetry
  astronomy/
    AstronomyProvider.ts     Sun/Moon, LAST, calendar controls, EQJ→ECEF
    data/                    generated HYG v4.1 bright-star subset + licence
  ocean/
    seaState.ts              canonical sea-state parameters and interpolation
    spectrum.ts              JONSWAP/Gaussian discretisation, growth, whitecaps
    presets.ts               the sea-state preset matrix
    SeaStateController.ts    smooth transitions between sea states
  scene/
    Waves.ts                 shared Gerstner definition + CPU sampling
    Ocean.ts                 radial water mesh and water shader
    FoamField.ts             persistent whitewater in Gerstner parameter space
    CrestSpray.ts            wind-torn crest spray
    OvertopSpray.ts          water thrown over the rail
    HullWetBand.ts           the wetted band the sea leaves on the topsides
    WindSystem.ts            wind presentation for the diagnostic raft only
    SkySystem.ts             atmosphere, sun and moon
    CloudDome.ts             marched cloud decks, cirrus, and the tile cache
    StarField.ts             real catalogue point field
    MilkyWay.ts              the galactic band
    WorldLighting.ts         the world's light terms and their diagnostic views
    TimeOfDay.ts             astronomy-fed lights and auto-exposure
    Lamp.ts / InteriorLamp.ts  deck and below-decks lights, as real lights
    WorldRenderAdapter.ts    ECEF/celestial → local Three.js mapping
    shaders/lib.ts           GLSL shared by the sky and the water
  vessel/
    Vessel.ts                active-vessel runtime contract
    VesselMotion.ts          canonical encounter projection
    BuoyantBody.ts           shared distributed flotation integrator
    schooner/                production hull, rig, mass and response model
      Schooner.ts            meshes + shared-body adapter
      hullForm.ts            the offsets, and the authority on ship coordinates
      rig.ts / rigGeometry.ts  spars, standing and running rigging, sail corners
      sailAero.ts            per-sail lift and drag at real centres of effort
      SchoonerSailForces.ts  the rig's wrench on the hull
      SailingControls.ts     tiller, sheets, hoists and reefs, rate-limited
      SchoonerBuoyancy.ts    schooner stations and coefficients
      SchoonerResistance.ts  passive surge/sway/yaw force surface
      SchoonerHorizontalDynamics.ts  fixed-step passive motion integration
      deckSurface.ts / deckFittings.ts / deckInterior.ts  the built ship
      interiorLight.ts       the room/portal daylight model and its channels
      closures.ts            doors, hatches and lids as one table, read by four
      crew/                  the invisible hands
        SailingCrew.ts       the crew as one standing-orders loop
        Trimmers.ts          six trimmer stations working the sheets
        Helmsman.ts          holds a course, or an apparent wind angle
        CrewOrders.ts        the order surface the player will share
    raft/                    opt-in legacy diagnostic vessel
      Raft.ts                procedural meshes, figure and effects
      RaftBuoyancy.ts        raft stations and coefficients
  camera/
    CameraSystem.ts          the two modes over one camera, and transitions
    CinematicCameraController.ts / EmbodiedCameraController.ts
  player/
    DeckWalker.ts            the body that walks the deck and ducks below
    Interactables.ts         what can be used, and from where
    SeatedStation.ts         sitting down, and what that changes
  terrain/
    TerrainSystem.ts         tiles, and the synthetic land of R1
  runtime/
    ProductionSimulationRuntime.ts  the seven-phase frame transaction
    VesselRuntime.ts / EnvironmentRuntime.ts / RenderPipeline.ts
    diagnostics/             the frozen-ray and DOM bridge
  render/
    GpuProfiler.ts           real GPU timing (EXT_disjoint_timer_query_webgl2)
    OceanTemporalResolve.ts  opt-in ocean TAA (?oceanTaa=1)
    adaptiveResolution.ts    the resolution walk
  input/InputController.ts   pointer, touch, wheel, keys
  world/openingVoyage.ts     the situation the page opens in, derived from the sea
  hud/PlayerHud.ts           the player-facing shell (pill, sheet, tabs)
  hud/playerPanels.ts        its five pages and what each may reach
  hud/compassRose.ts         the helm instrument: card, order, rudder
  hud/panels/                Helm, Sea, Sky, View, Perf (each lazy)
  ui/Hint.ts                 the temporary hint line
  ui/DevTools.ts             the developer-tools launcher shell
  ui/controls.ts             shared panel control builders
  ui/DebugPanel.ts           world and lighting panel (lazy)
  ui/DeveloperGlobe.ts       debug-only orthographic location picker
  debug/InspectionPanel.ts   scene-ray capture panel (lazy)
  runtime/diagnostics/BrowserDiagnosticsBridge.ts  frozen ray + DOM bridge
  debug/OceanLab.ts          ocean laboratory panel (lazy)
  debug/BuoyancyLab.ts       stepped verification harness (lazy)
  debug/SailingPanel.ts      the rig, the trim, the crew's stations (lazy)
  debug/DeckPanel.ts         deck, interior and lighting inspection (lazy)
  debug/GraphicsPanel.ts     lighting and render switches (lazy)
  debug/TerrainPanel.ts      terrain tiles and depth modes (lazy)
  debug/VoyagePanel.ts       the voyage clock and where she is (lazy)
  audio/Ambience.ts          procedural sea and wind
  styles.css
```

See [docs/ocean/OCEAN_SEA_STATE_SPEC.md](../ocean/OCEAN_SEA_STATE_SPEC.md) for the sea-state design,
[docs/ocean/OCEAN_SEA_STATE_REPORT.md](../ocean/OCEAN_SEA_STATE_REPORT.md) for what was built and
measured, [docs/ocean/OCEAN_ARCHITECTURE_AUDIT.md](../ocean/OCEAN_ARCHITECTURE_AUDIT.md) for the
state of the water before this round, [docs/world/WORLD_MODEL.md](../world/WORLD_MODEL.md) for the
mathematical contract,
[docs/adr/ADR-002-planetary-world-model.md](../adr/ADR-002-planetary-world-model.md)
for the architectural decision, [docs/ocean/OCEAN_PROTOTYPE_SPEC.md](../ocean/OCEAN_PROTOTYPE_SPEC.md)
for the original visual brief, and [docs/project/ASSET_CREDITS.md](../project/ASSET_CREDITS.md) for
dependency/data provenance.

For the ship and how she sails, see [docs/ship/SHIP_SPEC.md](../ship/SHIP_SPEC.md) (the canonical
vessel), [docs/ship/SHIP_BELOW_DECKS_PLAN.md](../ship/SHIP_BELOW_DECKS_PLAN.md) (the arrangement
below and the argument for it), [docs/sailing/SAILING_MODEL_DESIGN.md](../sailing/SAILING_MODEL_DESIGN.md)
(the four-layer sailing model) and [docs/sailing/SAILING_PROJECT_PLAN.md](../sailing/SAILING_PROJECT_PLAN.md)
(its rounds). [docs/project/FUTURE_ROUNDS.md](../project/FUTURE_ROUNDS.md) is the standing account of
what is built and what is deliberately not, and
[docs/README.md](../README.md) indexes everything else.
