# Ocean self-shadowing — spec for "Phase B"

**Status:** specified, not built. Written 2026-08-03 at the end of the shadow
round (see docs/graphics/SHADOW_ROUND_HANDOVER.md for what that round did and why this was
deferred).

**The observation this exists to answer**, in Ash's words: the sunset glitter
streak *"continues down the backside of waves which didn't look plausible."*
That is the one part of the original report still unfixed. The hull's shadow on
the water is done; the sea does not yet shadow itself.

---

## 1. What is actually wrong

A glitter highlight needs two independent conditions, and the renderer only
enforces one:

1. **Mirror alignment.** The surface must carry a normal that reflects
   camera → sun. This is `ggxSpecular` in `src/scene/shaders/lib.ts` and it is
   correct.
2. **Visibility.** That point must actually *see* the sun. If something upwind
   blocks the ray, no light arrives, and nothing can bounce into the camera no
   matter how well aligned the surface is.

The second condition is missing at wave scale, and it is not a rounding error.
At a 2 degree sun a 3 m crest throws an **86 m** shadow. Over that distance the
sea behind it should be dead — no glitter at all — and today it glitters freely.

### Why the BRDF cannot fix it

`ggxSpecular` already contains a Smith masking-shadowing term, and that term is
doing its job. But Smith G models occlusion *within the statistical microsurface
of a single shading point* — ripple hiding ripple, under an assumption that the
macrosurface is locally flat. It has no way to know that a swell ten metres
upwind is standing between this pixel and the sun. The scales are disjoint and
no amount of roughness tuning bridges them.

Note also what is *not* wrong: a wave face genuinely turned away from the sun is
already black, because the BRDF clamps `N·L`. What survives on the back of a
swell are the ripples whose own normals do point at the sun. They are locally
correct and globally wrong.

### Why a shadow map cannot fix it — measured, not assumed

The shadow round tried exactly this and it failed in three independent ways.
This is recorded at length in `docs/graphics/SHADOW_ROUND_HANDOVER.md` and summarised in the
comment above `SHADOW_VERTEX_SHADER` in `src/scene/Ocean.ts`. Briefly:

- **The map cannot resolve what it is shadowing.** The caster is the
  vertex-displaced Gerstner swell; the receiver shades with that *plus* a
  per-pixel residual gradient *plus* a procedural detail gradient. The ripples
  that make the glitter are not in the map, so the map can never shadow them.
- **The depth bias cannot be made to work at a low sun.** A 13.7 mm texel on a
  sea lit from 2 degrees spans 38 cm of depth; the offset available was 3.6 cm.
  The box filled with acne. It is sufficient only above roughly 21 degrees of
  elevation on a *flat* sea — that is, only where the term is not needed.
- **The box is the wrong shape.** At 2 degrees the shadows are 86 m long and the
  box was 28 m wide. Shadows cast from outside that band were simply absent.

**Do not reopen the shadow-map approach for the sea.** The failure is
structural, not a tuning miss.

---

## 2. Proposed method: an analytic horizon march

The ocean is a heightfield with a closed-form definition the fragment shader
already evaluates, and the sun is a directional light. For that pair the
visibility question has a direct answer that needs no depth map, no bias, and no
bounded volume:

> March along the sun's horizontal bearing from the shading point, tracking the
> maximum angle subtended by the surface ahead. If that horizon angle exceeds
> the sun's elevation, the point is shadowed.

Formally, for a shading point `p` on the surface with height `h(p)`, sun bearing
`d` (unit, horizontal) and elevation `e`:

```
horizon = max over t in (0, T] of  ( h(p + t*d) - h(p) ) / t
shadowed  when  horizon > tan(e)
```

Properties that make this the right instrument here, each one addressing a
specific failure above:

- **Unbounded.** There is no box, so there is no frustum wall, so it cannot
  draw the straight lines that started this whole round.
- **No depth bias.** Nothing is quantised into a texture, so the grazing-angle
  acne that killed the shadow-map attempt has no mechanism.
- **Consistent with the shaded surface.** It evaluates the same wave field the
  pixel is shading, at whatever fidelity we choose to march.
- **Cheap to gate.** When the sun is high the loop can be skipped entirely.

### Softness

`horizon > tan(e)` is a hard test and will alias. The sun is a disc of angular
radius ~0.00465 rad, so the transition should be smooth across that width:

```
visibility = 1 - smoothstep(tan(e) - k, tan(e) + k, horizon)
```

with `k` on the order of the solar angular radius, widened a little to cover the
march's own angular resolution. This is the same physical reasoning as the
variable penumbra already implemented for the vessel's shadow (see
`sunPenumbraTexels` in `Ocean.ts`).

---

## 3. The gate must come from the sea state

An earlier draft of this proposed skipping the march above ~25 degrees of sun
elevation. **That was derived from a calm sea and is wrong**, as Ash pointed
out: a Southern Ocean storm sea has slopes several times a swell's, and it
shadows itself at a far higher sun.

The correct gate is a comparison against the sea's own slope statistics, not a
constant. The wave field already computes a slope variance (`sigma2` in the
fragment shader, plus `uUnresolvedSlopeVariance`). Something of the form

```
march only when   tan(sunElevation) < GATE_SIGMAS * sqrt(sigma2)
```

with `GATE_SIGMAS` around 2–3, gives a threshold that rises automatically with
the sea state and collapses to nearly nothing on a flat day. **Derive it; do not
hardcode a degree value.** A regression test should assert the gate opens wider
for `SOUTHERN_OCEAN_ROUGH` than for a calm preset.

---

## 4. The open question is cost, and it decides the design

This is the part that separates this feature from the hull sky occlusion landed
in the same round. That term was ~10 ALU with no loop and disappeared below the
measurement floor. **This one is a march over real distance and will be
measurable.** At a low sun the ray may need to travel 100 m to find its blocker.

Two candidate implementations, to be chosen *by measurement, not by argument*:

### 4a. Per-pixel wave march

Evaluate the wave field at each step directly in the fragment shader.

- Reuses machinery that already exists; no new resources; exactly consistent.
- Cost is `steps × waves-per-step`. Evaluating all 48 slots at 16 steps is 768
  wave evaluations per pixel and is certainly too expensive.
- Mitigations: march only the longest components (the horizon at 50–100 m is
  dominated by swell, not chop); log-spaced steps, since near samples matter
  disproportionately; and the sea-state gate above.

### 4b. Observer-centred height window

Rasterise a coarse top-down height field around the observer once per frame and
march *that* in 2D, exactly as the foam field already maintains an
observer-centred window.

- Marching a texture is far cheaper per step than evaluating waves.
- Reintroduces a bounded window — but a 2D height cache can cover far more area
  than a shadow map's useful region, and its edge can be faded the same way
  `SUN_SHADOW_EDGE_FADE` already fades the vessel map's.
- Costs a per-frame update pass and memory.

**Measurement plan.** Both arms go behind a live A/B and through
`runPairedToggleBenchmark` (already generalised for this purpose in `main.ts`),
run in headless Chrome with `--enable-gpu --use-angle=metal` on a **quiet
machine**. The benchmark must be taken at a low sun in `SOUTHERN_OCEAN_ROUGH`,
because that is the worst case and the case that motivates the feature.

The saving from removing the ocean's 83k-vertex depth pass in the shadow round
is the natural budget to spend here, and it has itself not yet been measured.

---

## 5. Acceptance

- At a 2 degree sun in a rough sea, the glitter path is visibly **broken up** by
  crest shadows rather than continuous down the backs of waves.
- No straight lines, anywhere, at any sun elevation or camera azimuth. This
  round's original defect must not return in a new form.
- No acne: a flat or near-flat sea at any sun elevation shows no self-shadowing
  speckle.
- Above the sea-state gate the term costs nothing measurable.
- The look is A/B-switchable live, and the switch returns the production
  picture.

## 6. Risks

- **It may be subtle.** At the framings that matter the effect could be a
  texture change rather than an obvious one. Take the A/B to Ash's eye early,
  before optimising anything.
- **Temporal stability.** A marched visibility term will shimmer if the march is
  under-sampled while the wave field advects. Interacts with the optional ocean
  TAA; check both.
- **Double-darkening.** The Smith G term already removes some energy at grazing
  angles. Adding geometric shadowing on top may over-darken; watch the sunset
  exposure, which the colour pipeline round left sensitive.

## 7. Related

- `docs/graphics/SHADOW_ROUND_HANDOVER.md` — what was built, and the measurements behind the
  "do not use a shadow map" conclusion.
- `src/scene/Ocean.ts` — `SHADOW_VERTEX_SHADER` comment (why the caster is off),
  `sunSurfaceVisibility`, `sunPenumbraTexels`, `vesselSkyVisibility`.
- `docs/ocean/OCEAN_PERF_HANDOVER.md` — the ocean's existing per-pixel cost budget.
