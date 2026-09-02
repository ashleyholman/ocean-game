# WX3 moving sun-pool handover — 2026-08-18

## Outcome

A bounded second WX3 presentation slice is implemented. Broken cloud can now
cast broad moving pools of direct sunlight across the near and middle ocean.
The pool reads the cloud deck already on screen: its cover threshold, drift
offset and evolving 3D shape. It adds no cloud clock, cloud texture, volumetric
march, weather state, wind state or wave motion.

The direct-light chain is now:

```text
SkySystem shared cloud uniforms
        ├─ uCloudCover
        ├─ uCloudOpacity
        ├─ uCloudOffset
        └─ uCloudEvolve
                 ↓
Ocean: one cloud-density sample above each bounded water pixel
                 ↓
existing shared direct-sun gate
        ├─ glitter
        ├─ water-body sun
        ├─ crest transmission
        └─ wake haze / foam
```

`TimeOfDay`'s integrated sixteen-point solar-disc transmittance remains the
directional-light and far-ocean authority. Vessel and deck lighting remain on
that scalar; spatial vessel cloud shadow is not claimed by this slice.

## Spatial and performance contract

- The ray from an observer-relative water point to the sun is sampled once
  halfway along its bounded slab traverse. Above about seven degrees this is
  the slab's altitude midline; lower down it stays inside the existing 17 km
  reach. `cloudCoverAt` supplies regional organisation and
  `cloudDensity(..., detail = 0)` supplies the broad 3D shape.
- Beer-Lambert transmission uses that density over the same bounded geometric
  slab path as the established cloud model. There is exactly one
  `cloudDensity` call and no loop, `cumulusDeck`, `cloudBake`, texture or second
  volumetric march in the pool function.
- Horizontal coordinates are relative to the observer because the drawn
  directional cloud deck is too. Equal-and-opposite water/offset rebases retain
  the same sample; drift and evolution each change it deterministically.
- From 1.8 to 3.2 km the local sample hands back to the existing integrated
  scalar. At and beyond 3.2 km it returns that scalar before sampling, keeping
  the current far-horizon lighting statistic and avoiding cloud-field sample
  cost.

## Neutral and authority contract

`Ocean.uSunPoolStrength` defaults to zero. `ProductionSimulationRuntime` sets
it to one only when an attached `WeatherSystem` is non-neutral. Therefore all
of these retain the exact pre-slice scalar arithmetic:

- `?weather=off`;
- diagnostic/evidence runtimes without weather;
- clouds disabled by zero opacity;
- sun below the cloud-sampling horizon;
- water at or beyond the far bypass.

There is no new slider. The only switch is the truthful weather-neutral review
arm already present in runtime policy. Cloud cover, opacity, drift and evolution
remain owned by `SkySystem`; the ocean only reads their shared uniforms.

## Verification

- `npx vitest run tests/sun-pool-field.test.ts tests/shader-source.test.ts tests/production-simulation-runtime.test.ts`
  — **72 passed in 3 files** after the concurrent terrain capture-precedence
  regression joined the shared runtime suite.
- Adding `graphics`, `weather`, `weather-presentation`, and `cats-paw-field` to
  that command — **188 passed in 7 files**.
- `npm run build` — typecheck and production bundle passed; only the existing
  large-chunk advisory remains.
- Focused gates cover deterministic spatial variation, bounded output, drift,
  evolution, observer-origin continuity, exact cloud-off/sun-down CPU returns,
  grazing-sun reach bounds, neutral/live runtime policy, CPU/GLSL source
  agreement, one-sample budget, zero-first source order and exact far-horizon
  bypass.

## Required visual and timing verdicts

Browser automation was denied for this slice, so the following remain open:

1. In broken cloud, compare embodied, outside and high cameras. Confirm the
   pools are broad sunlight, not hard binary decals or cloud-coloured patches.
2. Confirm translation and evolution read as cloud weather moving over water,
   with no camera-centred marquee during camera transitions.
3. Inspect the 1.8–3.2 km hand-off for a visible ring and confirm the far
   horizon retains its established mean rather than pulsing with local gaps.
4. Record an identical off/on GPU timing pair. The source gate proves the
   single-sample/no-march budget, not its device cost.
5. Decide whether spatial cloud sunlight should later reach vessel/deck
   directional lighting. That is criterion 29's remaining half, not a silent
   extension of this ocean slice.

## Scope exclusions

No rain consequence, spray, spindrift, cloth, audio, cloud-type/WX4 work,
sun-pool reflection colour, wave displacement, buoyancy or orbital motion was
added or changed.
