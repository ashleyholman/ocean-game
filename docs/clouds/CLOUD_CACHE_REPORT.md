# Cloud cache round: the march moves off the frame

Ash's framing, which is the whole architecture: *"the clouds are just this
far distant dome that can be anchored around our camera... why do we have to
recalculate the cloud's pixel color every single frame?"* — and, one question
later, the refinement that made it exact: keep the marching cache, apply the
sun per frame.

## What was measured before anything was changed

M2, 2560x1440 backing store, GPU-fenced (readPixels; `gl.finish()` does not
synchronise in the agent browser — GRAPHICS_TODO already knew):

| piece | cost |
|---|---|
| whole frame | 80–105 ms |
| cloudLayer(): 96-step traverse x 5-step sun march, per sky pixel | 58–66 ms (~75%) |
| ocean fragment | 15–20 ms |
| everything else combined | ~2.4 ms |

A clear-sky pixel still cost ~480 noise evaluations — the march cannot know a
ray is empty until it has walked it. The march's *output* is a function of
view direction and slowly-varying state; only its *cost* was per-pixel
per-frame.

## What landed

### The factorization (shaders/lib.ts)

`cumulusDeck`'s integral separates exactly: per direction, six numbers — three
multiple-scattering accumulators `S_k = sum(w_i · powder_i · e^(-decay_k ·
tauSun_i))`, two ambient-occlusion weights, opacity — carry everything the
march learns about *geometry*, and every colour factor (sun tint and
transmittance, terminator, phase functions, ambient palette, moon) applies
OUTSIDE the sums. Cirrus adds two more channels (alpha, density).
`cloudBake()` emits the eight channels; `cloudLayerCached()` relights them.
Shared helpers (`cloudSunTau`, `deckSunLight`, `cloudMsPhases`,
`CLOUD_MS_DECAY/GAIN`...) keep the live march — retained, compile-switchable
via `CLOUD_LIVE_MARCH`, as the reference — and the bake reading one set of
constants.

### The cache (CloudDome.ts)

Two RGBA16F packs cover a logical equirect (6144x1280 desktop / 4096x768
mobile), elevation-warped so rows concentrate near the horizon —
the receding-tuft band that killed the earlier screen-space quarter-res
attempt is the *best*-resolved region here (~26 texels/degree against the
screen's ~34). The current implementation divides that map into 256x128
angular work tiles. One uniform snapshot fills only the camera-visible region
plus a 20-degree guard band in a staging MRT over 60 rendered frames, then
front and staging swap atomically. Every displayed tile therefore changes on
the same frame and shares the same two deck baselines.

A newly exposed guard tile is rendered on demand with the current display
snapshot, so a pan cannot reveal an empty cache or give the tile an independent
animation clock. See `docs/clouds/CLOUD_TILE_CACHE_DESIGN.md` for the scheduler and
acceptance criteria.

Storage is now sparse as well as work: a tiny page table maps the 240 desktop
logical tiles into 120 shared physical slots in each synchronized target.
One-texel procedural gutters preserve bilinear filtering between logical
neighbours that are unrelated in the physical atlas. The committed desktop
allocation is 122.8 MiB versus 240.0 MiB for the full double buffer; the
on-screen memory line reports both figures and any guard/visible slot miss.

### What ticks, what flows

Per frame, live and smooth: sun colour and intensity, the terminator
sweeping clouds into the Earth's shadow, silver-lining phases, ambient sky
and moon light, the sun/moon discs against per-pixel cached alpha, the gas
sky, stars, the dither. Per synchronized 60-frame generation: cloud shape
(wall-clock slow by the clock change below) and shadow *geometry* — tauSun
and the slant-depth factor are baked at the generation's sun. At 60 FPS,
a generation's worth of sun motion
at 72x is ~0.3 degrees: shadow boundaries move sub-feature distances per tick.

### The cloud clock (SkySystem.advanceCloudClock)

Clouds now advance on canonical world-time deltas DIVIDED by the world's
acceleration: wall-clock weather during play (the waves' own rule), and a
slider drag covers exactly the ground playing that span out would have — a
6 h scrub moves the deck 5 real minutes' worth, not the old timelapse hour's.
`CLOUD_TIME_RATE 0.2` (a 14.4x timelapse in play, "a bit ridiculous" — Ash)
became `CLOUD_WALL_RATE 1.0`; the graphics-panel dial now reads in wall-clock
multiples. Verified in-app: play drift 11.1 m per real second = 6 m/s wind x
1.85 Ekman gain, exactly; +6 h scrub = 3330 m, exactly.

## Results

Same instants, same 2560x1440, GPU-fenced:

| | before | after (cache) | live-march toggle, same build |
|---|---|---|---|
| day | 83.8 ms | **17.9 ms** | 58.8 |
| sunset | 88.4 ms | **18.6 ms** | 59.9 |
| night | 77.3 ms | **~17 ms** | 55.0 |

~4.7x. The remaining frame is the ocean (~13.4 ms) plus ~4.5 ms of
everything else including composite and bake bands (~1 ms amortised).

Frozen-sun cache-vs-live full-frame diff at day: mean 1.4 LSB, 8.4% of
pixels >2 LSB — the residue is the two paths' different dither rasters and
edge resampling, not structure. Same-instant crops (`evidence/crop-*` in the
session scratchpad): the horizon tuft band is intact, zenith shape and
cirrus wisps match; the cache's edge micro-texture differs slightly at 200%
zoom. **The sharpness verdict is Ash's, from the live app — the
`setLiveMarch()` toggle exists so the A/B is one console call.**

## Dials and open ends

- Tile size, guard and visibility padding — CloudDome.ts constants.
- `CLOUD_TILE_REFRESH_FRAMES` — cloudTileScheduler.ts.
- Logical cache size and sparse slot capacity: `SkySystem` constructor params.
- Zenith minification has no mips (bake-space fades band-limit the pole
  rows; watch for shimmer when orbiting under a zenith deck).
- The ocean's ~13 ms is the next lane (two per-pixel analytic skyRadiance
  evaluations, the 48-slot residual loop) — untouched this round.
- The parked screen-space CloudBuffer experiment (superseded by this design)
  is still in the branch stash; drop it when this round is accepted.
