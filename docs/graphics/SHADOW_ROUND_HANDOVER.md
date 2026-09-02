# Shadow round — handover

**Branch:** `claude/pbr-shadow-artifacts-fc6806`, off `6e6ec13`.
**Date:** 2026-08-03.
**Trigger:** Ash reported dead-straight lines in the water left and right of the
ship at sunset, plus a "shadow" much wider than the ship that started well
astern of her. Both introduced by `3096f1d`, "Shadow direct water light with
real geometry".

Three things were built. One was a bug fix, two are new. Sea self-shadowing was
specified rather than built — see `docs/ocean/OCEAN_SELF_SHADOW_SPEC.md`.

---

## 1. The reported bug: what it actually was

Three faults stacked, all confirmed by live A/B in the app rather than by
reading.

### 1a. The straight lines were the shadow box's walls

`getShadow` in three r185 returns a hard `1.0` the instant the coordinate leaves
the map, with no transition. That is tolerable in a normal scene. Here the
receiver is a plane reaching the horizon, so the frustum wall is a plane
crossing it, and a plane crossing a plane is a perfectly straight line on
screen. Worse, the box's long axis is the light, so those lines converge on the
sun — they appear exactly where the eye is already looking, down the glitter
path.

Proven by computing the shadow camera's footprint on the water and projecting it
over the A−B difference image: the outline lands on the artefact's edges.

### 1b. "Wider than the ship, starting astern of her" was the box, not a shadow

The footprint measured **27.8 m across x 240 m long**, centred on a 15.5 m ship:
`SUN_SHADOW_HALF_EXTENT = 14`, and `near`/`far` of 480/720 around a light parked
at 600 m. Nothing about that region was keyed to the hull.

### 1c. What filled it was acne, not wave shadowing

| | |
|---|---|
| shadow texel | 13.7 mm (28 m over 2048²) |
| available depth bias | 3.6 cm (`-0.00015` x 240 m interval) |
| depth across one texel at 2° sun | **38 cm** |

Short by ~10x. Sufficient only above roughly **21 degrees** of sun elevation on a
*flat* sea — and above 21 degrees crests barely shadow anything, so the term was
only trustworthy where it was not needed. Confirmed empirically by a bias sweep
(the darkening dissolves as the offset grows) and by an elevation ladder (at 25°
the ocean caster changed nothing; at 10° it changed 3.2% of the frame).

### 1d. A related dud found on the way

**`shadow.normalBias` does nothing on the ocean.** three r185 guards
`shadowmap_vertex` on `HAS_NORMAL`, which it defines only when the *geometry*
carries a `normal` attribute. The ocean disc carries `position` only, so
`shadowWorldNormal` compiles to `vec3(0.0)`. The lantern's `normalBias` is inert
for the same reason. Do not tune a number that is multiplied by zero. This is
now recorded in a comment at the assignment site.

### Not implicated

The point-sampled solar-disc cloud occlusion (`0398807`) reaches the water as
the single scalar `uSunCloudTrans`, which has no spatial structure and cannot
draw an edge. The lantern's cube map is on a vessel-only layer, so the ocean
never casts into it.

---

## 2. What was built

### 2a. Phase A — the fix

- **The sea is out of the sun's depth pass** (`mesh.castShadow = false`). Acne
  cannot recur, because a surface that is not in the map cannot self-shadow.
  This also deletes an 83k-vertex depth draw per frame. The displaced caster and
  its A/B switch remain in the file, with a comment recording the three reasons
  it is off.
- **The shadow term fades to lit before the map's border** rather than stepping
  at it, on all three axes so the far plane cannot draw a line either
  (`SUN_SHADOW_EDGE_FADE`). It also early-outs before the PCF taps outside the
  map, which on a wide ocean view is most of the screen.
- **The box was refitted to the vessel's shadow volume.** Depth span is the one
  shadow-map dimension that costs no texels — only precision — so it is now
  sized by where her shadow *lands* (40 m ahead, 440 m behind), which carries a
  14 m mast under a 2 degree sun. Lateral extent is unchanged at ±14 m.
- **The depth bias is derived from the depth interval**, not stated as a
  literal, so it stays a fixed distance of real water if anyone moves near/far
  again. That drift is exactly what produced the original bug.

### 2b. Hull sky occlusion (AO)

Motivated by a measurement, not a hunch: on the sunset glitter path only **39%**
of the water's brightness is direct sun. The other 61% is reflected sky — and
the water touching her planking was reflecting a whole unobstructed one.

`vesselSkyVisibility()` models the hull as a capsule about her waterline
centreline and removes a fraction of the sky by its solid angle, falling off as
inverse square. Roughly eight instructions, no map, no bounds.

Applied to the sky-driven terms **only**: reflection, the water body's ambient
share, the foam's. **Not** the sun, which owns a real depth map and would be
double-counted. **Not** the lantern, which hangs on the very hull doing the
occluding. Each of those is asserted by test.

This is an approximation of a real quantity, unlike the `raftAO` mask it
replaces — that one darkened the *direct* sun by proximity alone, so the sea
dimmed on the sunward side of the hull where it should have been brightest.

Measured at a 38 degree sun, close aboard, strength 0.00 vs 0.90: peak darkening
**61%**, with 16.4% of the frame moving more than 5%, 7.7% more than 10% and
2.7% more than 20%. In the water band beside her, **81%** of the brightness is
sky and ambient — so there is plenty for this term to act on, and the ceiling is
nowhere near reached at 0.45.

**A presentation lesson worth keeping.** The first contact sheet was six
separate panels in a 3x2 grid and Ash could see no difference between them at
all, despite the above. The eye is excellent at detecting an *edge* and poor at
comparing separated patches of a subtle tint. Re-shot as one continuous view cut
into adjacent vertical slices — each slice a different strength — the ladder
became obvious immediately. **For any ladder of a low-contrast global term, use
adjacent slices of one image, not a grid of panels.**

### 2b-ii. The mirror is a different question from the hemisphere

The first version applied the AO to the specular reflection as well, and that
was a real modelling error. AO is a hemisphere *average*, correct for a diffuse
integral. The reflection samples **one** direction, and whether the hull stands
in that direction has nothing to do with what fraction of the sky it covers.

It hid at noon and surfaced at dusk, which is exactly what the geometry
predicts. Looking down, Fresnel is about 0.03, the body dominates, and nobody
sees it. Looking across at dusk, Fresnel climbs, `mix(body, reflection,
fresnel)` becomes almost all reflection, and a hemisphere average smears grey
over water whose mirror ray is pointed at open sky. Ash caught it as "still
strong at twilight, which shouldn't be right".

The fix splits the term. Diffuse keeps `vesselSkyVisibility`; the reflection
gets `vesselMirrorVisibility`, a ray-versus-capsule test along `R` reusing the
hull axis the AO already needs. `VESSEL_SKY_OCCLUSION` drops to **0.45** and the
mirror gets its own, higher `VESSEL_MIRROR_OCCLUSION = 0.85`, because it is not
a fraction of a hemisphere — it is a mirror pointed at tar.

**A prediction that was wrong, recorded because the reasoning was seductive.** I
expected the directional test to *reduce* the dusk darkening, on the grounds
that most mirror rays point at open sky. Measured mean drop in the water beside
her at dusk: 0.75 hemisphere 5.7%, 0.45 hemisphere 3.3%, **0.45 directional
19.1%**. At a grazing view the water between eye and ship has its mirror ray
aimed straight at her over a large area, so the test fires nearly everywhere in
the near field. The term got *darker*, and correctly so — what changed is that
the darkness now has the shape of a reflection rather than of a wash, and the
warm twilight colour survives right up to her waterline where it used to grey
out. A mean is the wrong statistic for a question about where something lands.

### 2b-iii. Pulling the skirt in

Ash's verdict on the first landing: the halo is too large, weak by day and
strong at night, and it should be "only visible right around the underside".
Three causes, all of them reach rather than strength:

- **The diffuse falloff had a fat tail.** `r^2/(r^2+d^2)` is the correct solid
  angle of a sphere, and it is still a tenth of full strength three hull-widths
  out — which reads as a grey disc following her about. Squared, so the tail is
  1/d^4. A deliberate departure from the analytic form, taken because that form
  is also standing in for interreflection nobody models, and over-reach was the
  more visible error.
- **The radius was 3.2 m**, half-beam plus a margin, putting half strength a
  metre outside her planking. It is now the vessel's own `halfBeamM`, fed like
  the axis, so a raft no longer occludes like a schooner.
- **The mirror test had no distance falloff at all.** A ray either meets the
  capsule or does not, so a hull fifty metres downrange occluded as completely
  as one alongside — that is true of a mirror and false of water. The sea is
  rough, the reflection is a lobe of finite width, and a distant hull fills only
  a sliver of it. Occlusion is now weighted by her angular radius over the lobe's,
  which falls as 1/range and takes the halo in with it.

Measured at night, fraction of frame darkened by more than 5 per cent:
**10.18% before, 4.91% after** — the reach halved with both strengths untouched,
which is what Ash asked for. `uVesselOcclusionWide` restores the old shape for
the A/B.

### 2c. Variable-penumbra soft shadows

The cast shadow read as a decal because everything had the same razor edge. The
sun is a 0.53° disc, so a masthead 20 m downwind at a 38° sun should carry a
**~21 cm** penumbra where the old fixed filter gave **~2 cm** — about ten times
too crisp — while the hull's waterline contact should stay sharp.

A textbook blocker search is unavailable: the map is bound as `sampler2DShadow`,
which returns a comparison result rather than a depth, so there is nothing to
search. It is also unnecessary here. **For a plane receiver and one compact
blocker, the blocker's height is implied by how far downwind the pixel sits** —
shadow cast by something `h` up lands `h/tan(elevation)` away, so reading that
backwards gives `h` exactly, from the vessel axis already fed in for the AO.
Four instructions instead of a texture search.

That feeds a 12-tap Vogel disk of per-pixel radius, replacing three's fixed
5-tap. The metres-to-texels conversion comes from the live shadow camera, never
a literal, so resizing the box cannot silently rescale every soft edge in the
scene. A test pins that.

**Known ceiling:** the penumbra is clamped at 14 texels (~19 cm) so twelve taps
still cover the disc they sample. At a 2 degree sun the true figure is ~2 m, so
**sunset rig shadows are under-softened**. It degrades gracefully. Lifting it
needs more taps or a mip-based filter.

### 2d. Diagnostics added

- `ocean.setSunShadowForcedFull()` — occludes the direct sun everywhere,
  ignoring the map. This exists because "how much does this shadow remove?"
  cannot be answered by dimming the light: `uSunPower` also drives the sky's
  inscatter, so turning it down darkens the reflection the shadow is supposed to
  leave alone, and the answer comes out flattering. **A measurement taken that
  way said the shadow was 64% complete; the honest reference says 99.3%.**
- `runPairedToggleBenchmark` + `?perf=vessel-ao` and `?perf=soft-shadow`.

---

## 3. How to measure this (there was no how-to before)

**Instrument:** `EXT_disjoint_timer_query_webgl2`, `src/render/GpuProfiler.ts`.
GPU execution time, not CPU submission, not rAF wall-clock FPS. It does not time
draws individually — isolating a draw forces a tile-based GPU to flush work a
normal frame keeps deferred, which made even the star draw report nearly the
whole frame. It times cumulative prefixes over a six-frame rotation and
differences adjacent prefixes. Benchmarks read `gpuProfiler.rawSamples`
(unsmoothed); the on-screen panel reads the EWMA.

**The agent browser pane cannot do it.** It does not composite while hidden, so
timer queries are never retired and the collector waits forever. A `gl.finish()`
fallback there claimed 0.3 ms for a 2560x1440 volumetric-cloud frame.

**Use headless Chrome with the GPU explicitly enabled:**

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --enable-gpu --use-angle=metal \
  --user-data-dir=/tmp/drift-bench --window-size=1600,1000 \
  "http://localhost:PORT/?perf=vessel-ao&capturePort=5411&fixedDpr=1"
```

with `node tools/capture-server.mjs <outdir> 5411` running to receive the report.

Measured this round, same machine minutes apart: a **visible** window gave 63.8
ms/frame, **headless** gave 22.1 ms. A visible window costs 3x — the desktop
compositor and whatever else is on screen. Headless also removes the
window-focus and occlusion sensitivity entirely.

**Design the bracket for drift.** A blocked A-B-B-A charged machine drift to the
feature and produced 67→146 ms rows with ±74 ms deviations. Interleaved
**paired** off/on blocks with per-pair differencing fixed it.

**The historical ~18 ms baseline** is from `docs/clouds/CLOUD_CACHE_REPORT.md`, commit
`513fe5a` (2026-07-30): Apple M2, **2560x1440**, fenced with `readPixels` — a
*different instrument*. Day 17.9 ms, sunset 18.6, night ~17. Note the schooner,
her rig, world lighting, the colour pipeline and both shadow maps all landed
*after* it, so a naive comparison charges legitimate new content to drift.

---

## 4. Results, and how much to trust them

| | measured | honest reading |
|---|---|---|
| hull sky occlusion | −0.146 ± 1.692 ms | not resolvable; \|cost\| < 3.5 ms |
| soft shadows (12 taps vs 5) | −0.903 ± 2.183 ms | not resolvable; \|cost\| < 5.3 ms |

Both centred on zero with symmetric per-pair scatter including negative values —
what a zero-cost term looks like under noise, not what a cheap one looks like.

**These bounds are weak** because the machine was contended: nine dev servers
for this game were up and several other agent sessions were rendering the scene
concurrently. Analytically both terms are single-digit microseconds (AO is ~10
ALU over ~1 Mpx; soft shadows are 7 extra fetches on the ~15% of pixels that
pass the early-out). **Re-run all brackets on a quiet machine before quoting
anything firmer.**

**Not measured at all:** the saving from deleting the 83k-vertex depth pass.
That claim is structural and unproven. `runDirectShadowBenchmark` already exists.

---

## 5. What is left

**Feature work**
1. **Sea self-shadowing.** Specified in `docs/ocean/OCEAN_SELF_SHADOW_SPEC.md`. Still the
   only part of the original report unfixed.
2. **Penumbra clamp** at 14 texels, under-softening sunset rig shadows.

**Decisions for Ash**
3. `VESSEL_MIRROR_OCCLUSION = 0.85` is untested by eye — it is high because
   tar returns almost nothing, but 0.6 would keep the reflection's shape
   while lightening it. The soft margin (2.4 m to 6.1 m off her axis) is the
   other knob and is currently generous.

**Unproven claims / unfinished measurement**
4. The depth-pass saving (§4).
5. All perf bounds want a quiet-machine re-run.

**Known gaps, not regressions**
6. The moon has neither a shadow map nor AO, so the hull does not break
   moonlight glitter.
7. `?perf=direct-shadows` row labels are stale — its ladder was written when the
   ocean cast into the sun map by default. The levers work; the names describe
   the old world.
   > **Closed 2026-08-16** (correctness-and-truth round). The ladder moved to
   > `DIRECT_SHADOW_LADDER` at module scope in
   > `src/runtime/diagnostics/RuntimeBenchmarkDiagnostics.ts`, each rung now
   > carries a `shipped` flag, and the labels and summary lines say which rung
   > the game actually renders: **B by day, B + lantern by night**. C (the
   > displaced swell caster) is off by default and D is measured on top of C, so
   > no single row of this report prices production — the report now says that
   > too. `tests/diagnostics-architecture.test.ts` holds the labels to the sun
   > modes they drive and checks the bracket is still symmetric. Restructuring
   > was deliberately avoided: adding a rung changes what the paired
   > A-B-C-D-D-C-B-A cancellation is cancelling. **Owed on a cold machine:** the
   > shipped night figure, as its own paired lantern-on/lantern-off bracket at
   > `water-receiver`.
8. The raft path (`?debug=raft`) was wired for AO with `DECK_LENGTH/2` and a
   waterline of local zero, but never actually run.
   > **Closed 2026-08-16** (correctness-and-truth round) — exercised, not
   > deleted, because `?debug=raft` and `?debug=buoyancy` still build her. The
   > wiring is real and it does execute: `VesselRuntime.prepareOceanMasks` reads
   > whichever vessel is active every frame, and `main.ts` feeds
   > `setVesselOcclusionRadius(activeVessel.halfBeamM)` at startup. What was
   > missing was any check, and the failure that would hide is a quiet one — a
   > 3.2 m raft silently wearing the schooner's 15.5 m capsule would darken a
   > slab of sea four times her own length and it would read as water, not as a
   > bug. `tests/vessel-runtime.test.ts` now drives the real runtime with the
   > raft's real dimensions and measures the capsule that comes out. `Raft`
   > itself cannot be constructed under vitest (`OvertopSpray` reaches for a
   > canvas), so the contract is pinned where it is declared.

**Verified this round:** night (clean, sun shadow correctly deactivates below
the horizon), a 38° afternoon sun, and a 2° sunset. Typecheck clean; 434 tests
pass.

---

## 6. Things worth not relearning

- **A perf figure without its conditions is not a datapoint.** Resolution, DPR,
  instrument, and what else was running all moved the numbers here by 3x.
- **A "fully occluded" reference frame has to occlude exactly the terms under
  test.** Dimming the light is not that reference, and it flattered the answer
  by 35 points.
- **Ash's correction on the gate:** "above 25 degrees crests barely shadow
  anything" was derived from a calm sea and is wrong for the Southern Ocean. Any
  gate must be driven by the sea's RMS slope, not a constant.
- **The agent browser pane keeps lying in new ways.** Beyond the known traps, the
  rAF loop silently stops stepping the sim while `refreshLighting` still
  succeeds — so the water can be at sunset while the shadow camera is still
  pointed where the sun was an hour ago. An A/B ladder across four sun
  elevations came back byte-identical because of it. Verify
  `__sunLight.position.normalize()` against `sim.lighting.sunDirection` before
  trusting any lighting A/B taken there.
