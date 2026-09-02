# Drift — Atmospheric Ocean Prototype 0.1

## Purpose

A single-scene, browser-based atmospheric prototype. One tiny human on a crude
wooden raft, surrounded by an apparently limitless ocean at sunset, drifting
gradually into early night.

The question this prototype exists to answer: **is merely inhabiting this scene
compelling?**

It is not a sailing simulator, survival game, crafting game or management game.

## Visual hierarchy (non-negotiable)

1. Vast ocean and sky.
2. Changing light, waves and atmosphere.
3. A very small raft and human figure.
4. Almost no interface.

## In scope

- Animated Gerstner-wave ocean with CPU-sampleable wave definition.
- Coherent world-space sunset→night sky with sun, moon, stars, thin clouds.
- Small wooden raft (~3.2 × 2.2 m) with mast and rag sail.
- Tiny seated human figure (~1.75 m) as silhouette / scale reference.
- Distant oblique orbit camera preserving the horizon.
- Pointer/touch orbit + wheel/pinch zoom.
- One interaction: raise/lower the sail (Space, or click/tap the sail or mast).
- Wind-driven drift; faster with sail raised.
- Responsive desktop and mobile.
- `?debug=1` tuning panel.
- Optional minimal procedural ambience with `M` mute.

## Explicitly out of scope

Radio. Islands or land. Ships, whales, birds, encounters. Storms or multiple
weather states. Fishing. Paddling or steering. Survival mechanics. Inventory.
Map or compass. Saving or offline progression. Multiplayer. Narrative text.
Title menu. Any permanent HUD. Any additional system merely because it is
conventional.

## Technical plan

### Stack

- Vite + TypeScript (strict), Three.js, plain TS (no React).
- WebGL2 renderer, ACES filmic tone mapping, sRGB output, capped DPR.
- Procedural geometry and custom GLSL. No external binary assets required.

### Module map

```
src/
  main.ts                  bootstrap, render loop, resize, hint, mute
  scene/
    Ocean.ts               Gerstner mesh + custom water shader
    Waves.ts               shared CPU/GPU wave definition + sampling
    Raft.ts                procedural raft, mast, sail, figure, buoyancy
    SkySystem.ts           sky dome, sun/moon discs, stars, clouds
    TimeOfDay.ts           solar/lunar ephemeris, light colour, exposure
    WindSystem.ts          fixed wind direction, sail state, drift integration
    CameraRig.ts           spring-damped orbit rig, idle cinematic drift
  input/
    InputController.ts     pointer/touch/wheel/key, sail picking
  ui/
    Hint.ts                temporary fading hint line
    DebugPanel.ts          ?debug=1 only
  styles.css
```

### Ocean

- Radial/disc grid mesh, re-centred on the camera each frame so no edge is ever
  visible; vertex density highest near the viewer.
- 4–6 Gerstner components (broad swell 0.3–0.7 m amplitude total) evaluated
  identically in GLSL and TypeScript from one shared parameter table.
- High-frequency detail via procedural derivative-based normal perturbation in
  the fragment shader (no textures).
- Fresnel-weighted sky reflection, view-dependent specular sun/moon glitter,
  a sun-path streak broadened by wave slope statistics, subsurface-ish
  upwelling colour, horizon haze blend into the sky.
- Sparse foam on steep wave crests only.
- Deep blue / slate blue palette; never tropical turquoise.
- World offsets accumulate in a JS double; only a wrapped small offset reaches
  the shader, avoiding float precision problems during long drift.

### Raft buoyancy

- Sample the shared wave function at ≥4 points under the raft footprint each
  frame.
- Derive target height (mean), pitch and roll (least-squares plane fit).
- Critically-damped springs on height, pitch and roll give mass and remove
  jitter.

### Sky

- Single sky dome with an analytic Preetham/Hosek-flavoured scattering
  approximation driven by real sun direction.
- Sun disc with limb glow; moon disc with phase-free soft glow.
- Stars as a point cloud on the dome, fading in as a function of solar
  elevation; never dense while the sun is bright.
- Thin flat cloud layer, low coverage, lit from the sun side, drifting slowly.
- Sunset side and night side exist in genuine world directions — the contrast
  is discovered by orbiting, not forced into one frame.
- Default start shortly before sunset; ~10 real minutes to early night.

### Camera

Two of the brief's starting numbers turned out to be mutually inconsistent, and
were re-derived rather than approximated.

**The horizon lands at** `F_h = 0.5 · (1 − tan θ / tan(f/2))` of the frame
height, for optical pitch `θ` and vertical FOV `f`. At 48° FOV, a horizon on the
upper third needs `θ ≈ 8.6°` — not the 15–25° the brief suggests, which puts the
horizon at 9–12% and reads as a chase cam. The two are reconciled by keeping the
camera at ~16° *elevation* above the raft while aiming it `δ` above the raft, so
the raft simultaneously drops to 64% down the frame. `δ` is angular, so framing
survives zooming.

**Raft size is specified against the frame diagonal, not its width.** No single
distance gives 8–12% of *width* on both 1.6 and 0.462 aspects; at 48° FOV, 8–12%
of width forces 19–29 m, which is a chase cam. 5.4% of the diagonal gives
identical perceived smallness at every aspect.

As built:

| Parameter | 1440×900 | 390×844 portrait |
|---|---|---|
| Vertical FOV | 48.1° | 62° (clamped) |
| Distance | 36.3 m | 36.7 m |
| Camera elevation | 15.7° | 17.8° |
| Height above water | 10.1 m | 14.0 m |
| Horizon from top | 33% | 38% |
| Raft down frame | 64% | 58% |
| Raft width | 5.4% of diagonal | 6.8% of diagonal |

FOV is hybrid Hor+: `f_v = 2·atan(clamp(tan(35.5°)/a, tan21°, tan31°))`.

Orbit is clamped to 22–60 m and to an elevation of
`clamp(ε, max(10°, asin(6/D)), 26°)` — clamping elevation rather than height, so
a close orbit is pushed up instead of silently changing the framing. Follow is a
critically damped spring (ω = 1.6, ζ = 1) on horizontal position only; the
camera carries 15% of the raft's vertical bob through a 0.9 s low-pass and none
of its pitch or roll. Idle > 20 s → ≤12° azimuth drift over 30 s on a
smootherstep, transferred atomically into user azimuth on input so there is no
velocity discontinuity.

### Performance

- DPR capped (2.0 desktop, 1.75 mobile), reduced grid resolution and cheaper
  shading branches on small viewports.
- Zero per-frame allocation in the update path; all vectors preallocated.
- Target: smooth at 1440p desktop, ≥30 fps at 390 × 844.

## Acceptance criteria

The prototype is complete only when:

1. Opening the page immediately communicates "one tiny person drifting on a raft
   in an immense ocean."
2. The horizon is visible in the default view.
3. The raft is small but still readable.
4. The ocean has convincing large-scale motion and fine surface detail.
5. The raft visibly rises, pitches and rolls with the same waves.
6. Camera orbit reveals a spatially coherent sunset side and darker
   star-emerging side of the world.
7. Raising the sail visibly changes the raft and modestly increases drift,
   without introducing sailing controls.
8. After the temporary instruction fades, the normal scene has no visible UI.
9. Desktop and mobile layouts remain usable.
10. The production build succeeds with no material errors.

## Verification checklist

- `npm install`, `npm run build`, `npm run typecheck` all succeed.
- No material browser console errors.
- Orbit, zoom, touch verified in a real browser.
- Sail toggles repeatedly; raft stays locked to the waves.
- Resize / orientation change handled.
- Normal mode shows no debug UI and no permanent HUD.
- Every external asset (if any) recorded in `docs/project/ASSET_CREDITS.md`.
