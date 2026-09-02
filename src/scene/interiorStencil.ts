import * as THREE from 'three';

/**
 * The stencil mask that keeps the sea out of the ship.
 *
 * WHY THIS EXISTS
 * ---------------
 * The ocean is one displaced mesh over the whole world and it has no notion of a
 * hull. The captain's cabin sole is at 2.45 and the design waterline is at 2.30,
 * so any wave over 0.15 m is drawn *inside the room* — and the hold, when it is
 * built, has to put its floor lower still, around 2.0, which is permanently
 * under the waterline. Depth testing cannot save it: from an eye at 4.07 the
 * water at 2.6 is genuinely nearer than the sole at 2.45, so the sea wins on
 * merit.
 *
 * WHY KEEP THE STENCIL FALLBACK
 * -----------------------------
 * The production path cuts the hull's interior out of the ocean's fragment
 * shader. It has a measurable cost. `discard` is a *static* property of a
 * shader — the driver sees it in the source and marks the pipeline "may
 * discard", so visibility can no longer be resolved before shading. On the
 * tile-based deferred GPUs this runs on, that defeats hidden-surface removal for
 * the whole draw, whether or not any fragment ever discards. The ocean is the
 * most expensive shader in the frame and covers most of the screen, so the bill
 * is paid everywhere, to save a patch of pixels that the opaque hull was already
 * hiding for free.
 *
 * A stencil test is fixed-function and does not depend on shader output, so the
 * hardware can always run it *before* shading. It rejects the same fragments and
 * keeps HSR intact. The depth-correct shader volume remains the chosen default;
 * this cheaper path stays available if the GPU budget later needs the measured
 * 0.38 ms back.
 *
 * HOW IT WORKS, AND WHY THE DEPTH TEST DOES MOST OF THE WORK
 * ----------------------------------------------------------
 * Only the interior writes. Everything else is ordering:
 *
 *   1. the ship's exterior, rig and fittings draw   (`SHIP_RENDER_ORDER`)
 *   2. the interior draws, marking `INTERIOR_STENCIL_REF` where it survives
 *      the depth test                               (`INTERIOR_RENDER_ORDER`)
 *   3. the ocean draws, rejected where the mark is  (`renderOrder` 0)
 *
 * Step 2 is the whole trick: an interior surface only writes the mark if it is
 * *actually the nearest thing at that pixel*, because the exterior hull has
 * already written depth. Stand outside and the shell covers the cabin, the
 * interior fails depth, no mark is written, and the sea draws exactly as it
 * always did. Look down the open companionway and the sole is nearest, the mark
 * lands, and the sea is kept out. No second geometry pass, no volume to build,
 * and no case where the mask has to be reasoned about separately from what is
 * visible.
 *
 * THE ONE ARTEFACT, STATED PLAINLY
 * --------------------------------
 * A stencil is a screen-space test with no depth of its own, so it also rejects
 * ocean that is legitimately *in front of* a marked pixel. In practice that
 * means: a wave crest between the camera and the open companionway would be
 * punched through, showing the cabin sole. The hatch is 2.2 m above the
 * waterline and 0.84 m wide, so this needs a big sea and an external camera
 * looking at the quarterdeck past a crest. It is a real hole in the technique
 * rather than a bug in the wiring — no screen-space mask can be depth-correct —
 * and it is worth knowing before it is diagnosed as something else.
 */

/** The value the interior writes, and the ocean refuses to draw over. */
export const INTERIOR_STENCIL_REF = 1;

/**
 * Draw order. The ocean sits at 0, so both of these are ahead of it.
 *
 * The gap between them is load-bearing — see the note above. The exterior has to
 * have written depth before the interior tests against it, or an interior
 * surface hidden behind the planking would mark the stencil anyway and punch a
 * hole in the sea from outside the ship.
 */
export const SHIP_RENDER_ORDER = -2;
export const INTERIOR_RENDER_ORDER = -1;

/**
 * Mark this material's fragments as the inside of the ship.
 *
 * `stencilZPass` rather than `stencilFail`/`stencilZFail`: the mark is only
 * wanted where the fragment *passed* depth, which is what makes the mask mean
 * "the nearest surface here is interior" instead of "an interior surface exists
 * somewhere along this ray".
 */
export function markAsInterior(material: THREE.Material): void {
  material.stencilWrite = true;
  material.stencilRef = INTERIOR_STENCIL_REF;
  material.stencilFunc = THREE.AlwaysStencilFunc;
  material.stencilFail = THREE.KeepStencilOp;
  material.stencilZFail = THREE.KeepStencilOp;
  material.stencilZPass = THREE.ReplaceStencilOp;
}

/**
 * Refuse to draw this material where the interior was marked.
 *
 * `stencilWrite` has to be true even though nothing is written: in three it is
 * the flag that enables the stencil state at all. Every op is `Keep`, so this
 * only ever reads.
 */
export function rejectWhereInterior(material: THREE.Material): void {
  material.stencilWrite = true;
  material.stencilRef = INTERIOR_STENCIL_REF;
  material.stencilFunc = THREE.NotEqualStencilFunc;
  material.stencilFail = THREE.KeepStencilOp;
  material.stencilZFail = THREE.KeepStencilOp;
  material.stencilZPass = THREE.KeepStencilOp;
}
