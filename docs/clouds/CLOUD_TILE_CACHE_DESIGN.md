# Camera-local synchronized cloud tiles

Status: tiled cache implemented 2026-07-31; sparse storage added the same day.

## Decision

Keep the hemisphere-wide direction mapping, but march only the part the
camera can use. The cache is divided into angular tiles. A staging generation
fills the camera's visible region and a 20-degree guard band over 60 rendered
frames, then the entire generation is published in one atomic swap.

The tiles are work units, not independent animation clocks. Cloud shape and
baked shadow geometry therefore retain the original synchronized one-tick
behaviour instead of different parts of the sky stepping on different frames.

The update rate is deliberately frame-based: about one second at 60 FPS and
two seconds at 30 FPS. Falling frame rate never makes the scheduler increase
steady cloud work on an already slow frame.

## Layout

- Direction map: 6144×1280 desktop, 4096×768 mobile.
- Tile: 256×128.
- Desktop: 24×10 logical tiles.
- Mobile: 16×6 logical tiles.
- Fixed sparse pool: 120 desktop slots, 64 mobile slots.
- Each physical slot is 258×130: a 256×128 interior plus a one-texel gutter.
- Compact MRT atlas: 2064×1950 desktop, 1548×1430 mobile.
- Two compact MRT targets: displayed and staging.
- Each target has an RGBA16F attachment and an RG16F one containing the
  factored cloud packs. packB was RGBA16F while its z/w carried the cirrus
  deck; the deck was deleted on 2026-07-31 and two channels is all W1/W2 need.

The double buffer preserves one global cumulus drift baseline for every
displayed tile. That keeps sample-time advection and bilinear filtering exact
across tile boundaries; differently aged tiles are still never displayed
together.

A 24×10 (or 16×6) RGBA8 page table maps logical tiles onto arbitrary physical
slots shared by front and staging. The live shader performs ONE nearest page
lookup per sky pixel, shared by both packs, then two filtered cloud-data reads.
There was a second lookup while the high deck existed, because it rode a
different wind and had to slide its sample along it. An invalid entry returns
transparent cloud data, deliberately exposing bare sky.

Physical neighbours are not logical neighbours, so each tile bakes one texel
beyond every edge. Hardware bilinear filtering reaches that gutter rather than
an unrelated physical slot. The gutter is generated procedurally from the same
generation snapshot, so it is identical even when the neighbouring logical tile
has no slot.

Calculated committed texture storage:

- Desktop: 92.1 MiB sparse versus 180.0 MiB full, 49% saved.
- Mobile: 50.7 MiB sparse versus 72.0 MiB full, 30% saved.

These figures include both packs and both synchronized targets, plus the tiny
page table, but cannot include driver-private alignment. They fell by a quarter
when packB dropped to RG16F.

## Camera selection

The actual render camera is passed from the sky mesh's `onBeforeRender`
callback. A conservative rectangular angular-frustum test selects tiles using:

1. the perspective frustum's horizontal and vertical half-angles;
2. each angular tile's measured centre-to-corner radius;
3. two degrees of visible padding;
4. another twenty degrees for the guard band.

The guard exceeds the shader's maximum cumulus advection angle
(`atan(400 / 1350)`, about 16.5 degrees), so a displayed lookup cannot leave
the populated camera-local region during a scrub.

## Staging and the common tick

At the start of a generation, all bake uniforms are snapshotted once. For a
stable guard set of `N` tiles, its work is fractionally distributed across
exactly 60 rendered frames. For example, 66 tiles means one tile on 54 frames
and two tiles on six frames, rather than two tiles for 33 frames followed by
27 idle frames. A global round-robin cursor avoids restarting work when the
camera moves slightly.

The staging texture is never sampled while this work is in progress. On the
60th frame:

1. any current guard tile missing from staging is synchronously caught up;
2. displayed and staging targets swap;
3. the staging snapshot's two drift baselines are published with its textures;
4. a new live snapshot starts the next 60-frame generation.

Every existing cloud tile consequently redraws on exactly the same frame.

## On-demand camera-pan fill

A fast turn can reveal a guard tile that was never part of the currently
displayed generation. That tile is rendered immediately into the front target,
but crucially it is rendered with the current **display snapshot**, not live
uniforms. It therefore looks as though it had always belonged to the current
generation and does not acquire its own future tick schedule.

The newly exposed tile is also selected for the ordinary staging generation.
It changes again only at the next common atomic swap.

This is the intentionally accepted trade-off: a rapid pan can cost one or more
slow frames, but cannot reveal uninitialised cache data or desynchronise the
sky's animation.

## Observability and acceptance

The corner stats report visible tiles, guard tiles, resident/capacity slots,
guard and visible misses, exact calculated texture bytes versus the full
allocation, front on-demand work, staging work, final-frame catch-up, and
whether this frame performed the common tick. The existing GPU `cloud bake`
timer measures their combined batch.

Automated coverage includes tile geometry, stable 60-frame completion,
already-staged skipping, late guard membership catch-up, pool stability,
overflow priority, slot eviction, atlas packing, and de-duplication.
Runtime acceptance requires:

- one synchronized cloud-shape tick every 60 rendered frames;
- no tile seams immediately before or after the swap;
- slow and fast pans with no blank regions;
- azimuth-seam and zenith turns;
- time scrub and maximum-wind stress;
- cached/live-march parity at a fixed instant;
- a measured steady-state GPU comparison against the old 6144×22 full-width
  band.

## First runtime check

At 1280×720, DPR 1, the stable view selected 34–37 visible tiles and 65 guard
tiles. The fractional scheduler showed one tile on ordinary frames and two on
the distributed remainder, and the stats latch observed a single common
`tick` after the 60-frame cycle. Smoothed GPU cloud-bake readings settled
around 2.6–3.2 ms in the sampled views, versus the previously measured
8.7 ms actual cost of the old full-width 6144×22 band.

A fast horizontal pan reported 54 on-demand tiles in its peak frame. The
new view contained no blank cache region or visible tile seam, and the WebGL
console reported no shader/framebuffer errors. The sole warning was Three's
pre-existing `PCFSoftShadowMap` deprecation.

## Sparse runtime check

The default 16:9 cinematic view selected 28 visible and 53–54 guard tiles,
all resident with zero misses. A horizontal pan peaked at seven on-demand
tiles and showed neither blank regions nor tile seams. A committed time jump
rebased all 53 resident tiles in one batch and immediately returned to the
ordinary one-tile staging budget.

The deliberately extreme embodied straight-up view selected 83 visible and
131 guard tiles. The 120-slot desktop pool retained all 83 visible tiles and
reported 11 omitted far-guard tiles (`view miss 0`); the captured frame still
had no bare-sky hole. This is why the diagnostics distinguish guard misses
from visible misses instead of presenting one ambiguous overflow count.

At 1600×900 the pre-sparse full-atlas build sampled `sky + clouds` at about
1.58 ms in the captured steady frame. Sparse samples at the same scale were
about 0.64–0.84 ms; timer-query smoothing and adaptive resolution prevent
treating that as a precise speedup, but the two page reads caused no observed
regression. No WebGL errors were reported.
