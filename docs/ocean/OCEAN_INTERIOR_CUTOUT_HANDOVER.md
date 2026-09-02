# Keeping the sea out of the ship — both implementations and the measured choice

The ocean is one displaced mesh over the whole world with no notion of a hull.
The captain's cabin sole is at 2.45 and the design waterline is at 2.30, so any
wave over 0.15 m was drawn *inside the room*. Depth testing cannot fix it: from
an eye at 4.07 the water at 2.6 is genuinely nearer than the sole at 2.45, so the
sea wins on merit.

**This is not a cabin problem.** The hold's floor has to go to about 2.0 to buy
standing headroom amidships, which is 0.30 m *below* still water, permanently.
Anything built here has to serve the whole interior.

**Production default: the world-space volume test (option A).** It was built and
benchmarked on 2026-08-10, then selected with its measured exterior cost accepted
in exchange for depth correctness and a reusable hull-volume mechanism. The
stencil (option B) remains live behind `?interiorCutout=stencil` as a fallback.
Both share one build; `?interiorView=cabin` is the direct production-path cabin
review entry point. The numbers and the opposite result inside the cabin are
recorded in section 2.

---

## 1. What is built — B, the stencil

```
ship exterior, rig, fittings     renderOrder -2
the interior, marking stencil    renderOrder -1
the ocean, rejected on the mark  renderOrder  0
```

The interior marks `INTERIOR_STENCIL_REF` on `stencilZPass`, so it only marks
where it **survives the depth test** — where it is genuinely the nearest surface
at that pixel. That is what makes the mask mean the right thing without any
extra geometry: from outside, the shell covers the cabin, the interior fails
depth, nothing is marked, and the sea draws exactly as it always did. Down the
open companionway the sole is nearest, the mark lands, and the water is gone.

`stencil: true` had to go on the renderer in `main.ts`; it was explicitly off.

### Its one flaw, and it is inherent

**A stencil is a screen-space test with no depth of its own.** It rejects ocean
that is legitimately *in front of* a marked pixel as readily as ocean inside the
hull. Concretely: a wave crest between an external camera and the open
companionway is punched through, showing the cabin sole through the water.

The mask is only ever set where an interior surface is the nearest thing, and
from outside the ship that is exactly the hatch's screen footprint — 0.84 m wide,
2.2 m above the waterline. So it needs a big sea and a low external camera. Rare,
but real, and it is the *technique's* limit rather than a bug in the wiring.

---

## 2. What was owed — A, now built and measured

Take each ocean fragment's own world position — the displaced water surface point
the shader already has — transform it into ship-local space, test it against the
hull's interior volume, and `discard` if it is inside.

**A is depth-correct and has no artefact.** A wave crest in front of the hatch is
out in the sea, so its world position is not inside the hull volume, so it is not
discarded, and it draws over the sole exactly as it should. The stencil cannot
make that distinction; A makes it by construction.

**The reason it was not built first was a cost that had never been measured.**
`discard` is a *static* property of a shader: the driver sees it in the source
and marks the pipeline "may discard", so visibility can no longer be resolved
before shading. On the tile-based deferred GPUs this runs on, that defeats
hidden-surface removal for the whole draw whether or not any fragment ever
discards — paid across the screen, on the frame's most expensive shader, to save
a patch of pixels the opaque hull was already hiding for free.

**That mechanism is real, and the magnitude is now known for the reference
shot.** Before the run, the ocean's overdraw suggested losing HSR might cost
several percent or might disappear in the noise. The retained bracket below
resolves it at 3.84% of the close-exterior frame. It had been asserted twice in
the M4 session without being put on a clock; this experiment closes that gap.

### How A is built

- **Not a box.** A crude bounding box either eats sea *outside* the planking —
  visible from outside as a notch at the waterline — or leaves water in the
  corners of the room. Use the hull's own swept half-breadth: sample
  `halfBreadthAt(z, y)` into a small uniform array of half-breadths by station
  and height, or fit the two or three curves that already describe the topsides,
  and shrink it by a margin so the shell is always outside the cut.
- **Ship-local, from the vessel's inverse world matrix**, one `mat4` uniform
  updated per frame. Pitch and roll then come for free, exactly as they do for
  the stencil.
- **Bound it vertically** by the deck overhead and the top of the ballast, so the
  test is a couple of comparisons in the common case and the deep hull never
  needs describing.
- Keep the stencil path intact and switchable — the benchmark needs both live in
  one build, and the comparison is worthless if they are two builds.

### How to benchmark it

`runPairedToggleBenchmark` in `main.ts` is already the right harness — it is what
priced the hull sky-occlusion and the variable-penumbra shadow, and it takes an
`apply`/`read` pair exactly like the one wanted here:

```ts
await runPairedToggleBenchmark({
  title: 'interior cutout: shader volume test vs stencil',
  apply: (on) => ocean.setInteriorCutoutMode(on ? 'shader' : 'stencil'),
  read: () => ocean.interiorCutoutMode === 'shader',
}, () => undefined);
```

Follow the `perf=vessel-ao` block's framing decisions, which were chosen for
exactly this class of question: `SOUTHERN_OCEAN_ROUGH`, sun settled at 38°, the
cinematic camera close aboard at `(30, 16)`. **That framing is the point** — the
worst case for a term whose cost is per water pixel is the shot where the hull
fills the most screen-space water. A distant vista prices it at nearly nothing
and says nothing about the shot anyone looks at.

Run it headless, per `headless-chrome-gpu-benchmark`: headless Chrome with
`--enable-gpu --use-angle=metal`, paired interleaved blocks. **A visible window
costs about 3× and will drown the effect.**

Worth capturing a second framing from *inside* the cabin as well. That is where
the cutout does the most work and where A's fragment cost is highest relative to
the ocean actually on screen — and it is the one place the two techniques could
plausibly diverge in the opposite direction.

### What landed

- `src/vessel/schooner/interiorCutoutVolume.ts` samples the canonical
  `halfBreadthAt` form in placed ship-local coordinates, including the counter's
  rake. The 105×49 RGBA32F table is about 80 KiB.
- Each texel is the **minimum** half-breadth over its whole 15×8 cm cell, with a
  further 0.12 m inboard margin. Bilinear interpolation was tried and rejected
  before rendering: it interpolated straight across the sheer's discontinuity
  to zero and could cut water above the planking. The conservative cell leaves
  only a hidden sub-cell fringe behind the lining and cannot carve an exterior
  waterline notch. `tests/interior-cutout-volume.test.ts` probes the full swept
  field densely and pins both that safety property and full cabin coverage.
- Above the moulded sheer's edge, the table continues through the inner
  bulwark and closes across each raised deck's canonical camber. This matters
  aft: stopping at `halfBreadthAt` alone leaves the upper 0.55 m of the cabin
  uncut beneath the quarterdeck. A companionway-column test pins the full height.
- The fragment transforms `vWorldPos` by the live inverse vessel matrix, rejects
  outside the ballast-to-weather-deck and stern-to-stem bounds, performs one
  nearest table lookup over the ship footprint, then discards inside the
  shrunken width.
- `Ocean.setInteriorCutoutMode` switches separately compiled pipelines. The
  stencil arm contains no `discard`; the shader arm disables the fixed-function
  stencil read and compiles the volume test. `Schooner.setInteriorStencilEnabled`
  also stops the interior from populating an unused stencil in the shader arm;
  otherwise that arm would benchmark both techniques at once. A uniform-gated
  discard would have invalidated the comparison because both arms would remain
  may-discard pipelines.

### Result — Apple M2 / ANGLE Metal, three-run campaign, 2026-08-10

GPU-enabled headless Chrome, 1600×913 buffer at DPR 1, `SOUTHERN_OCEAN_ROUGH`,
sun 38°. Three independent runs each used eight interleaved off/on pairs and 16
timer rotations per block: 24 paired deltas and 384 raw frame samples per arm in
each framing. The in-app visual-review renderer was closed before all retained
runs. The shader arm disabled the interior's stencil writes as well as the
ocean's stencil read, so these are complete-technique costs. The raw brackets
and pooled calculation are preserved at
`evidence/performance/2026-08-10-interior-cutout.txt`.

| Framing | stencil means, runs 1/2/3 | shader means, runs 1/2/3 | pooled paired shader − stencil (mean ± SE) | reading |
|---|---:|---:|---:|---|
| close exterior, camera `(30, 16)` | 10.25 / 9.70 / 9.70 ms | 10.48 / 10.14 / 10.16 ms | **+0.379 ± 0.087 ms (+3.84%)** | resolved; 23/24 pairs positive |
| cabin interior, eye `(0, −5.9)` | 11.76 / 11.03 / 11.01 ms | 9.99 / 9.79 / 9.93 ms | **−1.363 ± 0.128 ms (−12.10%)** | resolved; all 24 pairs favor shader |

The opposite interior result is real and useful: from inside, the shader exits
at the top of the fragment before the large in-hull water region pays for the
ocean's shading, whereas the exterior shot pays the may-discard/HSR penalty over
the ordinary visible sea. Normal play is dominated by exterior and on-deck
views, so the repeatable 0.38 ms on the most important exterior framing is a
real budget choice. Ash accepted that cost on 2026-08-10: depth correctness and
one reusable mechanism for the schooner's present and future hull interiors are
worth it. **Ship A as production.** Keep B selectable with
`?interiorCutout=stencil` if a future GPU budget calls for the 0.38 ms back.

### What decides

- **If A costs nothing measurable, take A.** It is strictly more correct: the
  artefact in §1 disappears, and the mask stops being a screen-space
  approximation of a three-dimensional fact.
- **If A costs real milliseconds, make the budget choice explicitly.** That is
  the measured outcome above. The project chose correctness and hull reuse over
  the 0.38 ms exterior saving, while retaining B as the immediate fallback.

There is also a **third option that was named and not costed**: collapse ocean
triangles that fall inside the hull, in the vertex shader. No fragment cost, no
`discard`, HSR intact — but it can only cut at triangle granularity, so it must
either leave a fringe of sea against the ship's sides or over-cut and remove sea
just outside the planking. Worth a look only if A measures badly *and* the
stencil's artefact turns out to matter in practice.

---

## 3. What not to do

**Do not extend `raftAO`.** The ocean already carries a vessel-footprint disc for
sky occlusion, and it is on record in the M1 ship round as *"a hack to delete,
not to extend"*. Reusing its uniforms as a data channel is fine; growing it into
a geometry test is the thing that comment was written to prevent.

**Do not solve it by moving the sole.** `CABIN_SOLE_Y = 2.45` is set by what is
under it — ballast on the floors at 0.62, stores to about 2.0 — and it is already
only 0.15 m above the waterline. The hold needs to go *lower*, not higher.

**Do not let the stencil's comment drift.** `interiorStencil.ts` states the
artefact plainly. If A wins and replaces it, the artefact note goes with it; if B
stays, that note is the only thing standing between the artefact and an afternoon
spent diagnosing it as a depth-buffer bug.

---

## 4. The rooms changed the field's contract — 2026-08-10, M4's furnishing slice

The volume test was built against **one** room, whose sole at 2.45 sat 0.8 m
above the hull's own floor line at that station. `docs/ship/SHIP_BELOW_DECKS_PLAN.md`
put three floors below decks, ran the captain's cabin aft to the transom, and
broke an assumption nothing had had to state.

### 4.1 The erosion has a boundary problem, and a sole can sit in it

Each texel is the **minimum** half-breadth over its whole cell and the lookup is
**nearest-cell**, so the stored value has to be safe everywhere in the cell. That
is right wherever the section is narrowing toward water that is outside the
planking — the sheer, the rise of floor, the ends.

It fails where a sole sits close to the turn of the hull. At the cabin's after
end the sole is 0.17 m above the transom's floor line and the section closes
3 m of half-breadth per metre of height, so the cell straddling the sole was
eroded **0.16 m narrower than the room it exists to hide**: two strips of open
sea in the after corners, exactly where the four stern windows and the bench are,
whenever a crest rose the 0.15 m from the design waterline to the sole.

Two fixes, both in `interiorCutoutVolume.ts`:

- **`TRANSOM_CELL_REACH`** carries the transom's own section one cell abaft
  itself. Without it the boundary texel is the minimum of "the whole cabin" and
  "nothing at all", which is nothing.
- **`roomCutHalfBreadthAt`** is a second term: inside a room's own footprint the
  field is at least the room's half-width plus the margin the shader subtracts.
  The two terms accumulate **in opposite directions** over the cell — the shell
  as a minimum, because exceeding it is a notch in visible water; the room as a
  maximum, because falling short of it is sea on the floor. Composing them the
  other way round (one minimum over `max(shell, room)`) silently takes the
  narrowest room in the cell, which is 0.10 m out where the forecastle closes
  toward the stem.

`tests/interior-cutout-volume.test.ts` now asserts room coverage directly —
every room, every height in it, shortfall ≤ 1 µm — instead of asserting it about
the cabin as a special case.

### 4.2 The price, measured

Covering the rooms means the cut can leave the planking where a cell straddles a
boundary. The worst case is **1.43 m of half-breadth at the quarterdeck break**:
a cell there holds samples from the landing, whose ceiling is 0.55 m higher than
the waist's, so water between 3.73 and 4.28 disappears in a 0.155 m strip across
the beam. That is green water 1.4–2.0 m above the design waterline, over the one
patch of deck that already has a riser and a ladder breaking the surface up.

**The alternative was measured and rejected.** Capping the room term by the
*lowest* deck within a cell either way removes that artefact entirely and leaves
the top 0.55 m of the landing uncut — which is sea inside a room, the fault this
whole mechanism exists to prevent. The trade is deliberate and it is pinned by
size in `over-cuts outside the shell only where a room forces it`, so it cannot
grow quietly.

**If it ever has to go**, the lever is resolution rather than cleverness: the
conflict is entirely a consequence of one texel serving a 0.155 × 0.085 m cell
with a nearest lookup. Halving both costs 4× the table (about 320 KiB) and 4× the
build-time sampling, and shrinks every artefact here in proportion.
