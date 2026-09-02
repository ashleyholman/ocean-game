import * as THREE from 'three';
import { rayBox } from './Interactables';
import type { InteractableBox } from './Interactables';

/**
 * What is under the cursor, on a surface the player is sitting at.
 *
 * WHY THIS IS A RAY WHERE THE REACH PICK IS A CONE
 * ------------------------------------------------
 * `Interactables.pick` stopped being a ray test because Ash found what it cost:
 * a standing player aims a *crosshair* with their whole head, on a deck that is
 * heaving, at a hatch beside their boots. There is nothing to be strict about
 * there and the cone forgives it.
 *
 * A seated player has a cursor. A cursor is exact, it is the thing they are
 * looking at, and there is no version of "the book is roughly under the pointer"
 * that a player would thank you for — pointing at the desk beside the book and
 * getting the book is worse than getting nothing. So this is a strict ray, and
 * the forgiveness lives in the target instead: `deskItems.ts` pads its boxes.
 *
 * WHY IT WORKS IN SHIP-LOCAL SPACE
 * --------------------------------
 * Because that is where the boxes are, and because the ship is moving. The
 * desk's items are written against the desk, the desk is written against the
 * cabin, and the cabin is on a hull that is rolling, pitching and running at
 * three metres a second through a world coordinate system that itself rebases.
 * Transforming one ray into the hull's frame is one matrix inverse; transforming
 * every box out of it, every frame, is the same fault this ship keeps finding
 * from the other end — a second copy of a position, this one recomputed 60 times
 * a second.
 */

export interface PointerTarget<T> {
  readonly box: InteractableBox;
  readonly value: T;
}

/**
 * Whether the desk's object pointer belongs to the player's current state.
 *
 * A generic seated flag stopped being enough when the ship acquired forms,
 * berths and climbs: all of them use the same `SeatedStation`, but none of them
 * puts the player's hand at the captain's desk. The exterior camera is excluded
 * for the same reason. Pointing is an embodied object action, not a remote
 * screen control.
 */
export function canUseDeskPointer(context: {
  readonly seated: boolean;
  readonly atDesk: boolean;
  readonly embodied: boolean;
}): boolean {
  return context.seated && context.atDesk && context.embodied;
}

export class DeskPointer {
  private readonly ndc = new THREE.Vector2();
  private readonly raycaster = new THREE.Raycaster();
  private readonly inverse = new THREE.Matrix4();
  private readonly origin = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();

  /**
   * The nearest target under a client-space point, or `null`.
   *
   * `element` is the canvas the scene is drawn into, and its *rendered* rect is
   * what maps pixels to normalised device coordinates — not the window. The two
   * differ the moment anything is inset, and a pick that used the window would
   * be right in the middle of the screen and progressively wrong toward its
   * edges, which is the sort of bug that reads as "the hit boxes are a bit off".
   */
  pick<T>(
    clientX: number,
    clientY: number,
    element: HTMLElement,
    camera: THREE.Camera,
    shipMatrixWorld: THREE.Matrix4,
    targets: readonly PointerTarget<T>[],
    maxDistance: number,
  ): T | null {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    this.ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, camera);

    this.inverse.copy(shipMatrixWorld).invert();
    this.origin.copy(this.raycaster.ray.origin).applyMatrix4(this.inverse);
    // A direction is transformed without the translation, and normalising after
    // is what keeps `rayBox`'s distances comparable when the vessel group
    // carries any scale at all.
    this.direction
      .copy(this.raycaster.ray.direction)
      .transformDirection(this.inverse)
      .normalize();

    let best: { value: T; distance: number } | null = null;
    for (const target of targets) {
      const hit = rayBox(this.origin, this.direction, target.box);
      if (hit === null || hit > maxDistance) continue;
      if (best === null || hit < best.distance) {
        best = { value: target.value, distance: hit };
      }
    }
    return best ? best.value : null;
  }
}
