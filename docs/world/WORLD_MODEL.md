# Drift planetary world model

Status: implementation contract for development round 2.

This document defines the one physical world model used by Drift. The browser
continues to render a small, raft-centred ocean scene, but geographic position,
surface movement, orientation, and date/time come from the canonical state
defined here.

## Authoritative state

The mutable authoritative state is mathematically equivalent to:

```ts
interface CanonicalWorldState {
  worldInstantUtcSeconds: number;
  positionEcefM: Vec3d;
  velocityEcefMps: Vec3d;
  surfaceFrameEcef: {
    right: Vec3d;
    forward: Vec3d;
    up: Vec3d;
  };
  worldSecondsPerRealSecond: number;
  paused: boolean;
}
```

All values are CPU-side JavaScript `number` values (IEEE-754 binary64). No
Three.js vector, typed `Float32Array`, shader uniform, latitude, longitude,
course, local position, or UI value is an additional physical authority.

The frame has these invariants:

- every axis has unit length;
- axes are mutually orthogonal;
- `right × forward = up`;
- `up` is the outward WGS84 ellipsoid normal at `positionEcefM`;
- `right` and `forward` are tangent to the ellipsoid;
- `velocityEcefMps` is tangent to the ellipsoid.

Latitude, longitude, height, speed, course, apparent solar time, calendar
fields, and renderer directions are derived views.

## Units and boundaries

Internally:

- distance: metres;
- velocity: metres per **world second**;
- elapsed time: seconds;
- angles: radians;
- absolute time: UTC Unix seconds;
- celestial catalogue vectors: unit vectors in J2000 mean equatorial (EQJ).

Degrees and `Date` objects are used only at library, catalogue, debug UI, and
serialization boundaries. Names in the core carry unit/frame suffixes.

## Reference frames and axes

### Earth-centred, Earth-fixed (ECEF)

WGS84 ECEF is the geographic authority:

- `+X`: latitude 0°, longitude 0°;
- `+Y`: latitude 0°, longitude 90° east;
- `+Z`: north pole.

Future coastlines, destinations, weather, and current fields share this frame.

### Celestial

Catalogue stars are fixed EQJ/J2000 unit vectors. Astronomy Engine transforms
EQJ to true equator-of-date (precession and nutation), then Earth rotation
maps it into ECEF using Greenwich apparent sidereal time. Sun and, when
requested, other body vectors use the same celestial-to-Earth transform.

### Transported surface frame

The raft carries a continuous, right-handed tangent triad in ECEF. It is not
reset to east/north after movement. Conventional east/north is only a derived
geographic view.

### Conventional geographic frame

For geodetic latitude `φ` and longitude `λ`:

```text
east  = (-sin λ,              cos λ,             0)
north = (-sin φ cos λ,       -sin φ sin λ,       cos φ)
up    = ( cos φ cos λ,        cos φ sin λ,       sin φ)
```

This frame is used for bearings and telemetry away from the poles. It is not
carried through a pole.

### Three.js render frame

The local scene is raft-centred:

```text
Three +X = transported right
Three +Y = transported up
Three -Z = transported forward
```

For an ECEF direction `v`:

```text
x = dot(v, right)
y = dot(v, up)
z = -dot(v, forward)
```

For a nearby ECEF point, apply the same mapping to
`pointEcefM - raftPositionEcefM`. Raw six-million-metre ECEF coordinates never
enter ordinary GPU geometry.

## WGS84 surface

Constants:

```text
semi-major axis a = 6378137 m
inverse flattening = 298.257223563
semi-minor axis b = 6356752.314245179 m
```

Geodetic-to-ECEF follows EPSG method 9602. ECEF-to-geodetic uses a Bowring
estimate with double-precision refinement and explicit polar-axis handling.
The surface normal is the normalized ellipsoid gradient:

```text
normalize(x/a², y/a², z/b²)
```

It is not `normalize(positionEcefM)`, which is the geocentric radial direction
and differs from geodetic up away from the equator and poles.

Canonical ocean height is geodetic height zero. Rendered wave displacement,
heave, pitch, and roll are presentation effects and never modify ECEF altitude.

## Surface movement

Force-free movement is an ellipsoidal geodesic, not a fixed compass bearing.
The project geodesic interface accepts radians and metres and isolates
`geographiclib-geodesic` and its degree-based API.

For speed `s`, world elapsed time `Δt`, initial unit tangent `T0`, and initial
surface normal `U0`:

1. Derive temporary WGS84 latitude/longitude from ECEF.
2. Resolve `T0` into temporary east/north to obtain the initial azimuth.
3. Solve the WGS84 direct geodesic for distance `s Δt`.
4. Build endpoint ECEF position at height zero.
5. Build endpoint unit tangent `T1` from GeographicLib's forward endpoint
   azimuth and its returned latitude/longitude.
6. Set endpoint velocity to `s T1`.
7. Parallel-transport the carried frame as described below.

GeographicLib supports unrestricted distance, so constant force-free movement
does not need render-frame substeps, including offline-style elapsed durations
and repeated wraps around Earth. Future forces or sampled vector fields may
subdivide according to their own stated spatial/temporal error bounds.

Negative or non-finite elapsed time is rejected. Zero elapsed time or zero
speed leaves position and frame bit-for-bit stable.

## Exact tangent-frame transport

Along a geodesic, its tangent and the tangent rotated 90° are
Levi-Civita-parallel fields. Define:

```text
P0 = T0 × U0
P1 = T1 × U1
B0 = [P0, T0, U0]
B1 = [P1, T1, U1]
Q  = B1 B0ᵀ
```

`Q` maps the start geodesic basis to the endpoint basis. The carried `right`
axis is transformed by `Q`, projected once onto the endpoint tangent plane,
and normalized. Then:

```text
up      = U1
forward = up × right
```

This preserves the carried frame's coefficients in the geodesic path basis. It
is pole-safe, has no antipodal-normal ambiguity, and is independent of advance
step size. A stationary raft retains its exact frame.

## Poles and the antimeridian

ECEF position, velocity, and the transported frame remain finite through both.

- Longitude wrapping is display-only in `[-π, π)`.
- Longitude comparisons use circular difference.
- The exact polar axis uses longitude zero as a temporary propagation/display
  gauge.
- Endpoint tangent is constructed from GeographicLib's mutually consistent raw
  endpoint longitude and azimuth before an exact pole is collapsed to ECEF.
- UI course is unavailable below the pole-distance or speed threshold, even
  though a gauge azimuth can propagate the ECEF tangent.
- Teleport initialization uses east/north at the supplied location. At an
  exact north pole the deterministic frame is right `+Y`, forward `-X`; at an
  exact south pole it is right `+Y`, forward `+X`.

The antimeridian has no special physical operation. Only derived longitude
changes sign.

## Time domains

### Canonical world time

`WorldClock` mutates the canonical UTC instant through explicit delta inputs.
It never reads `Date.now()`. The application supplies the raw finite real
elapsed interval; it does not reuse the smaller delta that presentation
springs clamp after a stall or background pause. Its default scale is:

```text
30 world seconds / real second
2880 real seconds = 86400 world seconds
```

> **Superseded, 2026-08-17 (WX1).** This block said 72× and 1200 real seconds
> for a long time. The code has been 30× — 48 real minutes to the world day —
> since `DEFAULT_REAL_MINUTES_PER_WORLD_DAY` was introduced in
> `src/world/clock.ts`, which is the single tuning point both clocks initialise
> from. The stale figure is not harmless: it is where the original weather
> specification got its own wrong 72× from, and any new subsystem that copies a
> rate out of this document instead of consuming world seconds will inherit it
> again. `src/weather/WeatherSystem.ts` deliberately restates no number at all.

World elapsed time drives global geodesic travel and astronomy. Velocity is
metres per world second. Pause prevents both the instant and travel from
advancing. Direct debug scrubbing changes the absolute instant but does not
invent physical elapsed travel.

### Presentation time

`PresentationClock` advances from real frame deltas at visually natural speed
and drives waves, foam/noise phase, sail flutter, camera damping, character
motion, clouds, and audio modulation.

Presentation time never moves the canonical raft and never changes astronomy.
World acceleration deliberately does not replay every wave oscillation at the
accelerated clock rate; the renderer shows a plausible instantaneous local
ocean.

~~There is no third voyage clock.~~

> **Superseded, 2026-08-17 (WX1).** There is: `src/world/voyageClock.ts`.
> Distance made good was split off from the astronomical calendar when terrain
> rendered and 30× land slid across the horizon under a 1× sea. The voyage
> clock now runs at an honest 1× by default and is raised only deliberately,
> through `?voyage=` or the Voyage panel, or governed by the nearest land's
> apparent bearing drift. The calendar keeps its 30×.
>
> So there are three clocks, and a fourth view over one of them: the
> astronomical calendar (30×), the voyage compression (1×), presentation
> seconds, and — since WX1 — weather *state*, which is not a clock of its own
> but the calendar read through a dev-settable multiplier
> (`docs/weather/WEATHER_CONCEPT.md` §5b, decision D1). Weather *advection*
> stays on the wall clock, which is `CLOUD_WALL_RATE` and is a separate
> decision from this one.

## Local apparent solar time and calendar controls

Local apparent solar time (LAST) is derived from Astronomy Engine's topocentric
apparent Sun hour angle:

```text
LAST       = wrap24(12 h + hour angle)
```

Thus 12:00 means upper transit, not zenith. Astronomy Engine's hour-angle event
search changes canonical UTC until derived LAST equals the requested slider
value, including the equation of time. The search uses explicit UTC candidates
and has no wall-clock dependency. Values below 24 stay on the currently
selected apparent-solar day; `24:00` selects the following solar-day branch
rather than aliasing silently to the current day's `00:00`.

The continuous slider selects an integer day in the observer's derived
apparent-solar calendar year (365 or 366 days), then solves UTC again while
holding LAST. This avoids the slider changing date merely because a local solar
day straddles UTC midnight. UTC remains the sole canonical instant; the solar
calendar is calculated from it and LAST. Teleport records the derived solar
date and LAST, replaces canonical ECEF position and deterministically
reinitializes the frame, then solves UTC at the new location to preserve both.

## Astronomy

Astronomy Engine is the isolated astronomy backend. For an instant:

1. Obtain an apparent topocentric EQJ vector for the Sun (or requested body).
2. Apply EQJ-to-equator-of-date precession/nutation.
3. Rotate equator-of-date by `-GAST` into ECEF.
4. Project ECEF through conventional east/north/up for telemetry and through
   the transported frame for rendering.

The same 3×3 EQJ-to-ECEF rotation is applied once to the real star catalogue
point cloud. Stars are not assigned unrelated per-star time formulas.

Accuracy boundary:

- target visible Sun/Moon direction error: within 0.05° for 1900–2100;
- static-catalogue star direction error: within 0.1° near 2000–2050 and
  0.25° across 1900–2100 when proper motion is omitted;
- Astronomy Engine's stated solar-system target is about 1 arcminute;
- UTC is used as an approximation to UT1 (no live Earth-orientation bulletin);
- precession and nutation are included by the backend;
- catalogue positions are J2000 and proper motion is omitted in this round;
- atmospheric refraction is not part of canonical geometric direction;
- star brightness fading is a presentation function of solar elevation;
- the moon may use this body's shared direction pipeline, but accurate phase,
  surface orientation, and refined material remain deferred.

## Teleport and velocity semantics

Teleport changes only canonical state and absolute time:

1. Record current LAST and carried velocity components in the old transported
   frame.
2. Convert requested geodetic location to height-zero ECEF.
3. Initialize the deterministic tangent frame there.
4. Rebuild tangent velocity from the saved transported-frame components.
5. Solve canonical UTC to preserve LAST.
6. Recompute all derived navigation and celestial outputs.

Presentation time and wave phase are not reset.

## Snapshots

The versioned snapshot stores:

- schema version;
- UTC instant;
- ECEF position and velocity as decimal numbers;
- all transported frame axes;
- world-time multiplier and paused state.

Restore validates finiteness, WGS84 surface proximity, tangency,
orthonormality, and handedness. Latitude, longitude, course, solar time, and
renderer coordinates are deliberately absent.

## Numerical budgets

Project-level targets (looser than backend claims):

- ECEF/geodetic round trip: 10 micrometres;
- propagated surface height: 1 micrometre;
- ellipsoid equation residual: `5e-15`;
- trusted geodesic endpoint: 0.2 millimetres;
- frame unit/orthogonality/handedness residual: `5e-12`;
- tangency: `max(1e-12 m/s, speed × 5e-12)`;
- speed preservation: relative `1e-12`;
- one large step versus partitioned steps: 1 millimetre position and
  `1e-9` component agreement for the transported frame;
- LAST setters: 0.5 apparent-solar second;
- visible Sun/Moon reference cases: 0.05° unless a source warrants tighter.

Every canonical update rejects non-finite input and verifies its invariants.

## Extension points

- `SurfaceVectorField.sampleEcefMps(positionEcefM, worldInstantUtcSeconds)`
  for future currents;
- tangent acceleration/force providers with documented sampling bounds;
- nearby ECEF-to-render projection for islands and encounters;
- route/autopilot controls that set or accelerate tangent velocity without
  replacing the geodesic primitive;
- versioned snapshots for offline voyage progression;
- shared celestial-body vectors for a later complete moon/planet renderer;
- world-time-driven weather and radio schedules.
