# WX3 cat's-paw first-half handover — 2026-08-18

## Outcome

A bounded first half of WX3 is implemented. One deterministic spatial gust
field now drives the minimum ocean presentation needed to see cat's-paws:
resolved fine roughness/glint, active near whitecaps, and persistent foam
generation. It does not touch Gerstner displacement, buoyancy, orbital velocity,
developed swell, rain, cloth, audio, spindrift, or cloud shadow.

The field is staged as:

```text
WeatherState (m/s, m, s)
        ↓
CatsPawField retained CPU frame
        ├─ CPU sample API
        ├─ FoamField shared GLSL → local generation gate + drive
        └─ Ocean shared GLSL → detail/glint + live near whitecaps
```

`WorldWind` remains the instantaneous point-wind authority. The cat's-paw
field adds a spatial presentation departure around its mean; it owns no mean
wind setter and creates no second sea state.

## Field contract

- Four seeded integer ECEF harmonics are band-limited, mean zero and bounded to
  `[-1, 1]`; their weights sum to one.
- `WeatherState.gustExcessMps` is the maximum signed local departure. Patch
  scale and passage time are `gustPatchMetres` and `gustPeriodSeconds`.
- The pattern advects down the mean wind at one patch per passage time. The
  wrapped phase is integrated, so a direction change bends motion continuously
  instead of multiplying a new angle by a large absolute time.
- Canonical ECEF origin is wrapped into unit cycles on the CPU. Transported
  local X/Z axes are uploaded separately. Camera recentering, canonical-period
  crossings and render-frame rotation therefore do not rotate a distant
  lattice coordinate.
- CPU and GLSL are generated from the same harmonic table in
  `CatsPawField.ts`. The Float32 mirror agrees with the CPU path within
  `2.5e-5` over the focused sample grid.

## Authority and zero path

At positive physical amplitude, `FoamField` replaces its old private gust noise
with local speed from the shared field. It does not multiply two spatial gust
signals. The far-field statistical whitecap term remains on developed-sea wind,
as `WEATHER_CONCEPT.md` L2 requires.

At exactly `0 m/s`:

- Ocean skips every new normal, variance and live-whitecap operation.
- Foam executes its pre-WX3 `vnoise`/`gustiness` block verbatim. This is the
  comparison arm Ash requested, retained only when the new field is off.
- Neutral `?weather=off` publishes zero spatial amplitude.

Live weather derives physical excess from the existing documented temporal
peak fraction. Clear/rain/storm author `0.3 / 2.2 / 6.5 m/s`. The Weather panel
offers `Gust excess` in m/s, `Patch size` in metres and `Patch passage` in
seconds; choosing a coherent condition clears a manual field override.

## Verification

- `npx vitest run tests/cats-paw-field.test.ts tests/weather.test.ts tests/weather-presentation.test.ts tests/production-simulation-runtime.test.ts tests/shader-source.test.ts`
  — **127 passed in 5 files**.
- `npm run build` — typecheck and production bundle passed (only the existing
  chunk-size advisory).
- Focused gates cover fixed-seed repeatability, sampled mean and extrema,
  CPU/Float32 agreement, ECEF period and advection wraps, canonical origin
  shifts, transported-frame rotation, deterministic reset, runtime frame
  identity, physical controls, zero-path shader structure, and exact
  WaveField surface/velocity equality at maximum field amplitude.

## Required visual verdicts

1. Compare the same water/camera at `0 m/s` and the live/preset amplitude.
   Confirm zero is unchanged and positive amplitude reads as broad moving
   cat's-paws rather than a tiled colour grade.
2. Judge patch scale and passage speed in embodied, outside and high cameras.
3. Confirm stronger patches roughen/darken glint and increase only already
   plausible near breaking; the far horizon statistic must not pulse with them.
4. Watch a direction change and a long run across a wrap for any pop or foam
   marquee.

No browser verdict or GPU performance pair was requested for this bounded
slice. Those remain open together with sun pools and the wider WX3 readers.

Subsequent update: the bounded ocean sun-pool slice is now implemented; see
`WX3_SUN_POOLS_HANDOVER_2026-08-18.md`. Its visual and GPU timing verdicts remain
open, so this handover's original first-half review status is otherwise intact.

## Files in this slice

New:

- `src/weather/CatsPawField.ts`
- `tests/cats-paw-field.test.ts`
- `docs/weather/WX3_CATSPAW_HANDOVER_2026-08-18.md`

Modified:

- `src/weather/WeatherState.ts`
- `src/weather/WeatherField.ts`
- `src/weather/WeatherSystem.ts`
- `src/weather/WeatherPresets.ts`
- `src/debug/WeatherPanel.ts`
- `src/runtime/ProductionSimulationRuntime.ts`
- `src/scene/FoamField.ts`
- `src/scene/Ocean.ts`
- `src/runtime/RuntimeUi.ts`
- `tests/weather.test.ts`
- `tests/weather-presentation.test.ts`
- `tests/production-simulation-runtime.test.ts`
- `tests/shader-source.test.ts`
- `docs/weather/WEATHER_CONCEPT.md`
- `docs/project/CONTINUOUS_SESSION_PROGRESS_2026-08-17.md`
