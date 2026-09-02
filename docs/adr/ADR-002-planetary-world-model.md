# ADR-002: Planetary world model

- Status: accepted for round 2
- Date: 2026-07-28
- Amended: 2026-08-04 — astronomical and vessel-physics clocks separated;
  production encounter motion registered

## Context

The original ocean prototype independently integrated planar `worldX/worldZ`
inside the wind system and advanced a decorative sunset progress value. Those
were useful presentation devices, but they cannot support Earth-scale travel,
poles, absolute astronomy, persistence, routing, or global data.

Round 2 requires one physical state from which geographic and rendered views
are derived, while preserving the existing local Three.js ocean.

## Decision

Use height-zero WGS84 ECEF position, ECEF tangent velocity, an ECEF transported
surface frame, and UTC world instant as canonical state.

Use:

- `geographiclib-geodesic` 2.2.0 (MIT/X11) behind a project radians/metres
  direct-geodesic interface;
- Astronomy Engine 2.1.19 (MIT) behind a project celestial provider;
- an attributed 925-record, magnitude ≤ 4.5 bright-star subset from HYG v4.1
  (CC BY-SA 4.0), containing EQJ right ascension/declination, visual magnitude,
  B−V colour index, and labels;
- Vitest for deterministic mathematical tests.

The renderer remains vessel-centred. It receives directions and relative vectors
through one explicit surface-frame adapter.

## Why latitude/longitude are not authoritative

Latitude/longitude are a chart coordinate, not a globally regular movement
space:

- longitude is discontinuous at ±180° and indeterminate at a pole;
- equal angular increments do not represent equal distance;
- naïve integration does not follow an ellipsoidal geodesic;
- independently mutating latitude and longitude creates two coupled sources of
  truth and makes tangent velocity reconstruction ambiguous.

ECEF has one continuous Cartesian representation at the antimeridian and both
poles. Latitude, longitude, and height are derived only for UI and geographic
data access.

## Why ECEF velocity is authoritative

A tangent ECEF vector has unambiguous SI magnitude and direction everywhere,
including a pole. It can later combine with ECEF current, wind, and force
fields without degree/radian or longitude-wrap logic. Velocity is expressed per
ordinary physics second. Speed response and local water encounter use that
velocity directly. Global position integration applies a separate nominal 30×
voyage-time compression so long journeys fit the shortened day. Astronomical
debug rate and pause controls cannot change that voyage scale, speed response,
wind, waves, weather or local vessel motion.

## Why local east/north is derived

Conventional east/north depends on longitude and becomes a gauge choice at the
axis. Resetting the renderer or raft orientation to ENU after every movement
would create a flip at a pole and a hidden orientation source.

The carried frame is parallel-transported along the geodesic. ENU is generated
only when a compass bearing or geographic vector conversion is requested.

## Geodesic and frame transport

GeographicLib's Karney direct solution was selected because it converges at
antipodes, crosses poles/antimeridian, accepts unrestricted distance, and is
the official small JavaScript implementation with TypeScript declarations.

Frame transport uses the exact start/end geodesic path bases:

```text
Q = [T1×U1, T1, U1] [T0×U0, T0, U0]ᵀ
```

This is preferable to finite-step minimal-normal rotations. The latter are
locally reasonable but accumulate step-size-dependent yaw and have an
antipodal-normal ambiguity. Exact path-basis transport also avoids arbitrary
offline substeps when speed and direction are constant.

## Astronomy and time

Astronomy Engine was selected over hand-written solar formulas because it
provides a tested compact browser implementation, apparent solar-system EQJ
vectors, precession/nutation rotations, and Greenwich apparent sidereal time.
Its published target (about one arcminute, validated against NOVAS and JPL
references) is comfortably inside the project's 0.1° visual target.

The project composes one EQJ-to-ECEF matrix per update:

```text
EQJ → true equator-of-date → rotate by -GAST → ECEF
```

The Sun, catalogue stars, and later Moon/planets share this path. UTC
approximates UT1; there is no network dependency on Earth-orientation
bulletins. HYG star positions are treated as J2000 and proper motion is omitted
for the documented 1900–2100 game range.

Canonical `WorldClock` time defaults to a 48-real-minute astronomical day
(30×) and drives only UTC-dependent astronomy: the Sun, Moon and stars. It
consumes raw real elapsed time so a renderer stall does not lose calendar time.
Its rate, pause and direct time setters cannot move the vessel or alter wind,
waves, clouds or speed.

Vessel speed response and water encounter advance on the same bounded, ordinary
physics delta used by local buoyancy. Global ECEF travel multiplies the distance
integrated over that delta by a separately configured voyage scale, defaulting
to the same nominal 30× compression as the shortened day. Cloud/weather motion
uses bounded presentation time. This separation is explicit at the main-loop
call site: one call advances the astronomical clock and a different call
advances vessel physics and the compressed global voyage.

The day slider uses a derived apparent-solar calendar rather than storing a
second date. Its modulo-24 offset is unwrapped onto the branch nearest the
observer's longitude-derived mean-solar offset, preventing an equation-of-time
date flip near ±180°. Hour-angle searches are anchored to the selected solar
day; 24:00 alone requests the next midnight.

## Star catalogue

HYG v4 was chosen because it supplies a compact set of factual J2000
coordinates, visual magnitudes, colour indices, names, and constellation
labels under an explicit CC BY-SA 4.0 licence. Only bright records needed for
recognisable constellations are shipped; the full database is not bundled.
Provenance, source version, transformation, and licence are recorded in
`docs/project/ASSET_CREDITS.md`.

## Renderer boundary

Three.js `+X/+Y/-Z` maps to transported right/up/forward. ECEF is projected to
that frame on the CPU. The vessel, local waves, camera, sun, and point-star dome
remain within tens or hundreds of metres of the render origin. Rendered wave
heave and the 20 km procedural ocean disc are not geodetic state.

The original wind/sail system remains the speed provider, but its planar
position integrator is removed. It sets canonical tangent speed/direction;
only the world model advances location.

For production encounter motion, canonical speed is projected into the local
transported frame. The ship mesh remains at `(0, 0)` while the wave parameter
origin advances by the unscaled velocity on each 240 Hz buoyancy step;
mathematically this is identical to towing the hull through fixed wave
coordinates. Only the global geodesic distance receives the 30× voyage scale.
The ship's bow aligns with course. Foam history and airborne spray receive the
same local frame motion. This local offset is derived scratch, not a second
geographic position. Until a current field exists, speed through water equals
speed over ground.

## Alternatives considered

### Perfect sphere

Rejected as canonical. It simplifies great circles and frame transport but
does not meet the WGS84 requirement or future geographic-data alignment.

### Direct latitude/longitude integration

Rejected for metric distortion, pole singularity, antimeridian discontinuity,
and failure to follow an ellipsoidal geodesic.

### Vincenty direct solution

Rejected because convergence and antipodal behaviour are weaker than Karney's
method, with no compensating benefit for one raft.

### Resetting to ENU or storing course

Rejected because it introduces mutable derived state and a pole flip. Course
is telemetry and may be unavailable.

### Finite-step minimal rotation between normals

Rejected as the primary transport because its result depends on subdivision
and the opposite-normal case is ambiguous. The exact geodesic-basis mapping is
both simpler and stronger for force-free motion.

### Hand-written simplified solar equations

Rejected as production astronomy. They can be useful independent test
oracles, but commonly mix mean/apparent solar time, omit precession/nutation,
or create a second decorative sky clock.

### Observatory-grade EOP and ephemerides

Rejected for this round. Live DUT1/polar-motion bulletins and large JPL
ephemeris files add network/data complexity far beyond the visual accuracy
target.

### Earth-sized render coordinates

Rejected because Float32 GPU precision at six-million-metre magnitudes would
damage the existing metre-scale waves and raft.

## Consequences

Benefits:

- one serialisable global state;
- pole/antimeridian continuity;
- exact ellipsoidal force-free travel and frame transport;
- independently deterministic astronomy, local physics and compressed voyage
  time domains;
- a local renderer that retains good numeric precision;
- clean future field, route, persistence, and celestial extension points.

Costs and limits:

- two small production dependencies and one attributed catalogue subset;
- conversions at debug/geographic boundaries;
- UTC≈UT1 and static J2000 stars limit observatory use;
- the current sail speed response remains deliberately simple;
- wave animation and local encounter run in real physics time; only the global
  voyage distance receives the fixed time-compression factor;
- horizontal speed is still a legacy/debug target rather than the result of
  sail, rudder, keel, drag and current forces.
