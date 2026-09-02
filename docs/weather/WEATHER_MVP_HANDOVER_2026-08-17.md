# Weather MVP handover — 2026-08-17

## Outcome

A coherent weather vertical slice is implemented. The developer Weather tab can
select live generation, the exact neutral/off baseline, or bounded clear, rain,
and storm conditions. Each condition is a complete `WeatherState`, not a bag of
independent visual toggles.

The runtime chain is:

```text
Weather panel / ?weather=
        ↓
WeatherSystem → WeatherState
        ├─ wind → WorldWind → vessel / sea memory / rain lean / world cue
        ├─ cover threshold → existing SkySystem uniform + cache seam
        ├─ visibility → existing Ocean and mounted Terrain haze seams
        ├─ precipitation → deterministic near-rain field
        └─ electrical activity → seeded strike → delayed thunder cue
```

`WorldWind` remains the only instantaneous wind authority. `RainField`,
`WeatherWindCue`, and `WeatherPresentation` construct no `WorldWind`, expose no
wind setter, and read its instantaneous direction/magnitude after the production
wind transaction has published the frame.

## What landed

### Conditions and controls

- `?weather=clear`, `?weather=rain`, and `?weather=storm` are strict startup
  options alongside live, numeric live rate, and `off`/neutral.
- The Weather developer tab exposes those five conditions, sea coupling, the
  weather clock, independent near-rain/lightning/wind-vector presentation A/Bs,
  and a deterministic manual review strike.
- Selecting an Ocean sea state while a weather preset is armed exits the authored
  weather preset to live before `recalibrateTo`, preserving that method's existing
  promise that an explicit sea declaration takes effect exactly.

| condition | pressure | wind | rain | visibility | electrical |
|---|---:|---:|---:|---:|---:|
| clear | 1026 hPa, rising | 4.5 m/s, light gusts | 0 mm/h | 15 km | 0 |
| rain | 995 hPa, falling | 10 m/s, gusty | 12 mm/h | 3.5 km | 0 |
| storm | 975 hPa, falling rapidly | 18 m/s, severe gusts | 32 mm/h | 0.9 km | 0.95 |

Directions are deterministic offsets from the voyage's prevailing wind and wrap
through north with the existing compass helper.

### Environment and rain

- Cloud-cover threshold is published into the existing shared sky uniform.
  Large authored jumps request one cloud-cache rebase; slow live changes use the
  cache's ordinary staged generation.
- Visibility mutates the existing ocean and mounted-terrain haze-distance
  values; it does not retain a second atmosphere state.
- Near rain uses one preallocated `LineSegments` buffer (maximum 1,400 drops).
  Drop phase is seeded and periodic in world space; the camera selects the nearby
  periodic image rather than dragging the pattern. Absolute presentation time
  drives the fall. Instantaneous `WorldWind` drives streak lean.
- Zero precipitation sets draw range to zero and hides the object exactly.

### Lightning and thunder

- Fixed 11-second candidate slots use seeded hash draws. Electrical activity is
  only the admission threshold; zero activity is exactly event-free.
- Each accepted event owns one strike bearing, distance, intensity, flash time,
  and `thunderAt = flashAt + distance / 343`.
- The emissive bolt geometry is fixed for the flash and uses twelve
  preallocated solid strokes, rather than a one-pixel line lost among rain.
  Its envelope is an absolute-time double pulse, so render cadence cannot
  reshape it. The manual review strike sits just off the current gaze to avoid
  being hidden by the schooner's masts and sails.
- The same event enters a thunder queue. When its delay expires, the existing
  `Ambience`/`SoundGraph` renders a deterministic low-passed noise one-shot through
  the exterior-air/enclosure bus. Before the first audio gesture, the cue is a
  safe no-op like every other graph voice.
- No dynamic three.js light is added: neutral weather keeps the established
  material light-count/shader variants. In-cloud/world illumination is an
  explicit WX6 follow-up rather than a hidden always-on render cost.

### Wind cue

- The Weather tab can show a cyan in-world torus and solid arrow beside the
  vessel. It chooses the observer-facing side, sits forward in the helm view,
  and scales its offset from the active vessel footprint, including the raft.
- Its speed-reading length remains common across vessels, while shaft, head,
  and origin-ring cross-sections shrink with vessel beam. This keeps the
  schooner cue legible without turning the raft cue into a large cyan fitting.
- Arrow direction is the instantaneous `WorldWind` compass direction transformed
  by the current render-frame heading. Length maps instantaneous speed from 1.5 m
  at calm to 7 m at 24 m/s and above.
- It starts hidden in every session so neutral/off remains an uncluttered A/B;
  the Weather tab shows it explicitly.

## Verification

- `npx vitest run tests/weather.test.ts tests/weather-presentation.test.ts tests/runtime-architecture.test.ts tests/ambience.test.ts tests/sound-mapping.test.ts tests/production-simulation-runtime.test.ts tests/runtime-ui.test.ts`
  — **157 passed in 7 files**.
- The focused suite pins preset bounds/coherence and URL policy; rain density,
  repeatability, world anchoring and lean signs; direct `WorldWind` provenance;
  zero-activity schedules, reset determinism, monotonic thunder delay and manual
  coupling; presentation kill switches; and no-AudioContext degradation.
- A dedicated fresh-construction/double-construction scene-graph test guards the
  clean-navigation path independently of Vite HMR state.
- Latest integrated `npm test` — **1,801 passed, 27 skipped** across 118 passing
  files and one skipped file. `npm run build` and typecheck pass.
- A live in-app browser eye pass covered clear daylight, bright-water rain,
  dark storm rain, the solid wind vector from the helm and outside, and the
  off-gaze double-pulse bolt. Follow-up passes covered the cue at close and far
  diagnostic-raft scales and the bolt against a bright overcast afternoon.
  Both remain immediately readable without swallowing the raft or disappearing
  into the sky. Thunder has not been auditioned.

## Required eye-and-ear review

1. Compare `?debug=weather&weather=off`, `clear`, `rain`, and `storm` at the same
   camera/time. Confirm cover and haze transitions feel coherent rather than like
   a grade change.
2. Judge rain against bright sky, dark sea, and moonlit night: density, streak
   length, lean, near-field seam, and whether unlit line material reads as rain.
3. Schooner helm/outside and diagnostic-raft close/far wind-vector views now
   pass. Keep the vector an explicit teaching overlay; a more atmospheric
   streak/particle language is a later art-direction choice, not hidden MVP work.
4. Night and bright-overcast-afternoon review strikes now read clearly as bolts.
   Revisit presentation width only when authored branching/cloud illumination
   enters WX6.
5. Unmute, trigger a strike, count to the thunder, then repeat below decks. Judge
   level, low-pass character, decay and enclosure muffling.

## Deliberately staged after the MVP

- WX3 spatial cat's-paws and moving pools of sun.
- WX4 cloud type and ceiling profiles, overcast soft-shadow work, and transition
  weighting beyond the existing cover threshold.
- WX5 far rain/shafts, ocean impact rings/roughness, deck/hull wetness, rain bed,
  and open-hatch consequences.
- WX6 in-cloud volume illumination, authored bolt branching, exposure acceptance,
  spatial thunder and performance evidence.
- Off/on GPU evidence at desktop/mobile/4K and a committed weather contact sheet.

## Files

New:

- `src/weather/WeatherPresets.ts`
- `src/weather/RainField.ts`
- `src/weather/StormEvents.ts`
- `src/weather/WeatherWindCue.ts`
- `src/weather/WeatherPresentation.ts`
- `tests/weather-presentation.test.ts`
- `docs/weather/WEATHER_MVP_HANDOVER_2026-08-17.md`

Modified:

- `src/weather/WeatherSystem.ts`
- `src/weather/WeatherState.ts`
- `src/weather/WeatherEvidence.ts`
- `src/runtime/RuntimeOptions.ts`
- `src/runtime/RuntimeUi.ts`
- `src/runtime/ProductionSimulationRuntime.ts`
- `src/debug/WeatherPanel.ts`
- `src/scene/Ocean.ts`
- `src/audio/noise.ts`
- `src/audio/SoundGraph.ts`
- `src/audio/Ambience.ts`
- `src/main.ts`
- `tests/ambience.test.ts`
- `docs/weather/WEATHER_CONCEPT.md`

The integrated MVP is checkpointed in `2c2f446` on `master`; the subsequent
raft cross-section correction is part of the next cohesive checkpoint.
