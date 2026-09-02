# Drift round 2 — planetary simulation report

## Outcome

The prototype now has one canonical WGS84 world state. Absolute UTC, height-zero
ECEF position, surface-tangent ECEF velocity, transported ECEF frame,
world-time rate, and pause state are authoritative. Latitude/longitude, course,
solar time, calendar fields, Sun/Moon directions, star orientation, and all
Three.js directions are derived.

The original ocean, raft, camera, ambience, and atmosphere remain a small
raft-centred presentation. Six-million-metre ECEF coordinates never enter
ordinary scene geometry.

## Baseline recorded

Before round 2:

- `npm ci`, `npm run build`, and `npm run typecheck` succeeded;
- Vite already emitted its non-fatal single-chunk size warning;
- the repository had no test script, so `npm test` was a pre-existing failure;
- travel was integrated independently as planar `WindSystem.worldX/worldZ`;
- `TimeOfDay.progress` was a decorative sunset clock and Sun authority;
- stars were a random shader hash field fixed in local scene space.

No unrelated work was discarded.

## Canonical movement and frame transport

`PlanetaryWorld` advances one explicit world delta atomically for travel and
UTC. At the default 72 world seconds per real second, 1,200 real seconds is one
world day. Velocity is metres per world second.

Force-free travel uses the official `geographiclib-geodesic` 2.2.0 JavaScript
port of Karney’s WGS84 direct solution, isolated behind a radians/metres project
interface. It supports short steps, exact pole crossings, the antimeridian,
unrestricted multi-wrap distance, and offline-style large elapsed intervals.

The carried tangent frame is transported exactly in the geodesic path basis:

```text
Q = [T1×U1, T1, U1] [T0×U0, T0, U0]ᵀ
```

This preserves the carried frame’s path-basis coefficients without a
step-size-dependent minimal-normal rotation. `up` is always the normalized
WGS84 ellipsoid gradient, not the geocentric radial direction.

At an exact pole, ECEF state remains regular and longitude uses a documented
zero gauge. Endpoint tangent is constructed from GeographicLib’s mutually
consistent raw longitude/forward-azimuth result before pole snapping. Course
and conventional solar azimuth are reported unavailable at the singular axis.
The antimeridian has no canonical operation; only displayed longitude wraps.

The old planar travel integrator is gone. The fixed-wind/sail component now
supplies a target physical speed and presentation sail animation only.
Exponential speed response and travelled distance are integrated analytically,
so one large update and many partitions agree.

## World and presentation time

The deterministic `WorldClock` owns no mirrored instant and never reads wall
time. The application supplies the full monotonic real delta to canonical
advancement—even after a render stall—while camera, waves, cloth, character,
cloud, and audio presentation consume a separate delta capped at 50 ms.

Pause stops UTC, geodesic travel, and physical speed response together. Direct
debug scrubbing changes UTC without inventing voyage distance. Visible waves
remain a plausible real-time instantaneous local ocean rather than replaying
accelerated wave oscillations.

## Astronomy and stars

Astronomy Engine 2.1.19 supplies topocentric apparent Sun/Moon EQJ vectors,
precession/nutation, Greenwich apparent sidereal time, and Sun-hour-angle event
search. One row-major transform is composed per update:

```text
EQJ/J2000 → true equator of date → rotate by −GAST → ECEF
```

Sun, Moon, and all catalogue stars then cross the same ECEF-to-transported-frame
renderer boundary. The real Sun drives the visible disc, directional light,
atmosphere, twilight, and ocean reflection. The existing Moon material is kept;
accurate phase/surface rendering remains deferred.

The random star shader was removed. `StarField` renders 925 real HYG v4.1 stars
at magnitude ≤ 4.5 with J2000 right ascension/declination, visual magnitude,
B−V colour index, and labels. Polaris and the principal Southern Cross stars
are explicitly covered. The generated data is CC BY-SA 4.0, checksum-pinned,
reproducible, and documented.

Local apparent solar time is `wrap24(12 h + Sun hour angle)`. Sliders solve the
astronomical hour-angle event rather than applying longitude alone, so noon is
upper transit—not assumed zenith. The derived solar-calendar branch is selected
relative to observer longitude, including near ±180°, and is never another
stored clock. `24:00` explicitly chooses the next solar midnight.

## Developer controls

`?debug=1` now provides:

- 00:00–24:00 local apparent solar time;
- a 365/366-day solar-calendar slider with month markers;
- world-time multiplier and pause;
- a draggable orthographic globe with graticule and marker; clicking teleports
  to WGS84 height zero while preserving LAST and solar date;
- explicit true-course, wave, wind, camera, and exposure controls;
- latitude, longitude, height, ECEF position, speed, true course/unavailable
  reason, ECEF velocity, UTC, LAST, solar date/day, clock rate, and Sun
  azimuth/elevation/horizon status.

Normal mode constructs none of the debug panel or globe DOM.

## Validation and tolerances

The 65 deterministic tests include:

- EPSG and analytical WGS84 fixtures, exact poles, a southern mid-latitude site, high latitudes,
  heights, and 500 deterministic random round trips;
- official GeographicLib/Karney direct vectors;
- north and south pole crossings, including an exact pole as an intermediate
  step;
- eastward and westward antimeridian crossings with a rotated carried frame;
- multi-wrap travel and one-step versus 1,000-step equivalence;
- random tangency, orthonormality, handedness, surface-normal, and speed
  invariants;
- exact configured clock scaling, 30-world-day distance, pause, a 30-second
  stall, presentation isolation, analytical speed response, and transactional
  snapshots;
- published/reference Sun cases for NREL SPA, equinox, Tasman Sea summer/winter,
  Tromsø summer/winter, sunrise, upper transit, polar day, and polar night;
- EQJ/ECEF rotation sign, factor-of-15 protection, proper-rotation invariants,
  Polaris, all five principal Crux stars, several LAST-preserving teleports,
  leap year, 24:00, poles, and both date-line branches;
- renderer-axis/matrix tests with a deliberately rotated transported frame;
- star catalogue count, field ranges, SHA/provenance, licence, and key-star
  coverage.

Documented project budgets are 10 µm for ECEF round trips, 1 mm for
large-step/partitioned endpoints, approximately `2e-10` maximum accepted
runtime frame residual, tangency
`max(1e-12 m/s, speed × 5e-11)`, 0.5 apparent-solar second for setters, and
roughly 0.05° for cited Sun fixtures. These are project-level targets, not
claims of observatory accuracy.

## Accuracy boundary and deferred visuals

- UTC approximates UT1; there are no live DUT1, polar-motion, or leap-second
  bulletins.
- Astronomy Engine includes precession/nutation and targets about one arcminute
  for solar-system bodies; the project does not claim better.
- HYG directions are treated as static J2000; proper motion is omitted. The
  intended game range is 1900–2100.
- Shared celestial directions are geometric; atmospheric refraction is not
  applied to the star sphere.
- Moon phase/surface orientation, sharper star material, weather, currents,
  coastlines, routes, autopilot, and offline voyage systems remain deferred in
  `docs/project/FUTURE_ROUNDS.md`.

The focused browser pass checked normal/debug modes, noon, midnight catalogue
stars, a high-latitude polar-night scene, a high-latitude summer/noon scene,
globe drag/teleport, LAST/date preservation, and telemetry. It caught and fixed
a duplicate star-shader attribute declaration. Fresh normal and debug loads
then produced no browser-console warnings or errors.

## Principal files

| System | File |
|---|---|
| Canonical state, travel, controls, snapshots | `src/world/PlanetaryWorld.ts` |
| WGS84 conversion, normal, bases, invariants | `src/world/wgs84.ts` |
| Direct geodesic isolation | `src/world/geodesic.ts` |
| Exact frame transport | `src/world/frameTransport.ts` |
| Canonical/presentation clocks | `src/world/clock.ts` |
| Navigation telemetry | `src/world/navigation.ts` |
| Astronomy, LAST, solar calendar | `src/astronomy/AstronomyProvider.ts` |
| HYG generated catalogue and licence | `src/astronomy/data/` |
| ECEF/celestial renderer boundary | `src/scene/WorldRenderAdapter.ts` |
| Catalogue star renderer | `src/scene/StarField.ts` |
| Astronomy-fed lighting | `src/scene/TimeOfDay.ts` |
| Debug controls and telemetry | `src/ui/DebugPanel.ts` |
| Developer globe | `src/ui/DeveloperGlobe.ts` |
| Architecture contract | `docs/world/WORLD_MODEL.md` |
| Decision record | `docs/adr/ADR-002-planetary-world-model.md` |

## Verification commands

```bash
npm ci
npm test
npm run typecheck
npm run build
```

The final test and type-check runs pass. The production build passes with
Vite’s non-fatal warning that the single JavaScript chunk is larger than
500 kB (approximately 719 kB minified / 209 kB gzip).
