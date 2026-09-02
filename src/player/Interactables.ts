/**
 * Things aboard that a person can work with their hands.
 *
 * WHY A REGISTRY AND NOT A KEY PER VERB
 * -------------------------------------
 * The raft prototype originally had one action — the sail — bound to a bare key
 * with no target: press it anywhere aboard and the sail moved. That did not
 * survive contact with the schooner's interior. The hatchway boards came up,
 * and behind them were the cabin door, sea chest, chart drawers, drop boards at
 * the companion and deadlights over the stern windows. A key per verb needs a
 * key per object; "act on what you are looking at" needs one.
 *
 * The codebase already had the right shape and only on touch: *tap the sail to
 * raise it*. This is that, generalised, and the desktop key becomes the same
 * question — what is under the crosshair, within reach?
 *
 * WHAT AN INTERACTABLE IS AND IS NOT
 * ----------------------------------
 * It is a **box in ship-local space, a verb, and a toggle**. It is deliberately
 * not a mesh, a material or a piece of geometry: what the player points at is a
 * volume, and tying the pick to the drawn triangles would make every interactable
 * a thing that has to be found in the scene graph and kept in step with it. The
 * hatchway boards are drawn in one region, collided with in another and walked on
 * by a third — a fourth description keyed to any one of them would be the "two
 * sources for one position" fault this ship has now found six times.
 */

export interface InteractableBox {
  readonly xLo: number;
  readonly xHi: number;
  readonly yLo: number;
  readonly yHi: number;
  readonly zLo: number;
  readonly zHi: number;
  /**
   * Rotation about the vertical, radians, about the box's own centre. Absent
   * means square with the ship, which every hatch aboard is.
   *
   * **It is here because squaring a turned target up cost a room.** The captain's
   * chair is reached from a volume of clear sole 0.87 m by 1.06 m lying at the
   * desk's own 6.6°; reported as the smallest upright box containing it, that
   * volume reached 0.13 m further forward than the standing space really does,
   * and a player in the landing — through a bulkhead, in the next room — was
   * offered the seat. The pad this target already carries is deliberate slack in
   * every direction at once; a bounding box is slack in exactly the direction the
   * piece is turned, which is the direction the neighbouring room is in.
   */
  readonly yaw?: number;
}

/**
 * One side of something that can be worked.
 *
 * A target and the place it is reachable from are one record deliberately. A
 * hatch has a target above the deck and another below it; attaching one room
 * veto to the whole hatch either lets the lower room work the upper face
 * through the planking, or makes one of its legitimate sides unusable. Keeping
 * the reach volumes beside their own target makes decks and bulkheads semantic
 * occluders without coupling the picker to render meshes.
 */
export interface InteractableTarget {
  readonly box: InteractableBox;
  /** The eye must be inside at least one of these volumes. Absent means anywhere. */
  readonly reachableFrom?: readonly InteractableBox[];
}

/**
 * A point turned into or out of a box's own axes, so a turned box tests exactly
 * like a square one and only these two functions know the difference.
 *
 * `sense` is −1 going into the box and +1 coming back out; +1 is
 * `roomFitting.frameToShip`, which is where the sign convention is set.
 */
function turnAboutBox(
  point: { x: number; y: number; z: number },
  box: InteractableBox,
  sense: 1 | -1,
): { x: number; y: number; z: number } {
  if (!box.yaw) return point;
  const cx = (box.xLo + box.xHi) / 2;
  const cz = (box.zLo + box.zHi) / 2;
  const cos = Math.cos(box.yaw);
  const sin = Math.sin(box.yaw) * sense;
  const dx = point.x - cx;
  const dz = point.z - cz;
  return { x: cx + dx * cos + dz * sin, y: point.y, z: cz - dx * sin + dz * cos };
}

/** The same for a direction: the rotation without the origin. */
function turnDirection(
  direction: { x: number; y: number; z: number },
  box: InteractableBox,
  sense: 1 | -1,
): { x: number; y: number; z: number } {
  if (!box.yaw) return direction;
  const cos = Math.cos(box.yaw);
  const sin = Math.sin(box.yaw) * sense;
  return {
    x: direction.x * cos + direction.z * sin,
    y: direction.y,
    z: -direction.x * sin + direction.z * cos,
  };
}

export interface Interactable {
  readonly name: string;
  /**
   * The state this thing is in, read from wherever that state actually lives.
   *
   * **This used to be a single `ClosureState` handed to the registry, and the
   * captain's chair is what broke it.** Every row aboard was a closure, so one
   * `isOpen(name)/toggle(name)` window served them all; a seat is not a closure
   * — `seatState.ts` sets out why at length — so the registry would have needed
   * a second window, and then a third, and a switch to pick between them.
   *
   * A row owning its own accessor is the version that scales, and it keeps the
   * property the old design was built for: the registry still holds no state of
   * its own, so what the prompt says and what the ship does cannot drift. The
   * closure is now on the row instead of in the class.
   */
  isOn(): boolean;
  /**
   * What the player is told they can do, in the state the thing is in now.
   *
   * A function rather than a string because the verb is the state: the same
   * boards are "Lift the boards" and "Lay the boards". A label that did not
   * change would be a button that lies half the time.
   */
  verb(on: boolean): string;
  /**
   * Where it is and which side of a wall or deck may reach that particular box.
   * A function of state because an open hatch is not where its shut lid was.
   */
  targets(on: boolean): readonly InteractableTarget[];
  /**
   * Do the thing.
   *
   * Deliberately not "toggle": a hatch toggles, and a seat *seats you*, which is
   * a camera move, a held walker and a chair that slides out. What the two have
   * in common is that pressing the key does whatever the verb just said it
   * would, and that is the only thing this interface should insist on.
   */
  activate(): void;
}

export interface ReachHit {
  readonly interactable: Interactable;
  readonly on: boolean;
  readonly distance: number;
}

/**
 * How far a person reaches to work something, metres, **measured from the eye**.
 *
 * That last clause is the whole of it, and getting it wrong made the first
 * version of this unusable in a way no test would have caught. An arm's reach
 * is about 0.7 m and a step is another 0.8, so 1.6 seemed generous — until you
 * point at the deck. **The eye is 1.62 m above the floor**, so a 1.6 m ray
 * cannot touch the planking a body is standing on, let alone a hatch beside its
 * feet. Every floor-level object in the ship would have been unreachable, and
 * the boards are the first floor-level object.
 *
 * 2.2 m is the real quantity: a person bends to lift a board, so the hand
 * reaches the floor and the *eye* is still a body's height away from it.
 * √(2.2² − 1.62²) = 1.49 m of horizontal reach at floor level, which is the arm
 * plus the step the old number was trying to express, now measured from the
 * place the ray actually starts.
 *
 * It is still short enough for the failure it guards against: a player in the
 * wardroom cannot work the hatch in the forecastle because it happened to line
 * up, which would read as the ship doing things by itself.
 */
export const REACH = 2.2;

/**
 * The interactables aboard, and the pick that finds one.
 *
 * **The registry owns no state, and that is deliberate.** The first version of
 * this kept its own `Map` of what was open, alongside the one in `closures.ts`
 * that the geometry and the floor query read — and they drifted inside an hour:
 * the prompt said "Lift the boards" over a hatch that was already open. That is
 * this project's oldest fault wearing a new hat, the one
 * `hullForm.cabinHeadroomAt`, `INDEX_Y_LO` and the bilge pump's mass entry each
 * cost a round: **two sources for one fact.**
 *
 * Each row is a window onto the single copy instead. What a player sees named
 * on screen and what the ship's floor does are then the same boolean, and
 * cannot be made to disagree.
 */
export class Interactables {
  constructor(private readonly items: readonly Interactable[]) {}

  /**
   * What the player means, within reach — or `null`.
   *
   * WHY THIS IS A SMALL CONE RATHER THAN A RAY
   * ------------------------------------------
   * It was, and Ash found what that costs: *"I found it quite fiddly getting
   * the action text to appear when I was nearby the scuttle. I had to slowly
   * step around a few different directions for it to appear."*
   *
   * A strict ray-box hit asks the player to put a crosshair on a thing at their
   * feet. Standing beside the scuttle the eye is 1.17 m above the lid and about
   * 0.7 m out, so the box is nearly 60° below the horizon — you have to look at
   * your own boots to hit it, on a deck that is heaving under you. The target
   * was never small; the *aim* was.
   *
   * So the pick is a narrow cone rather than a ray, scored by how close to the
   * centre of view a thing is. A genuine ray hit has zero angular error, and a
   * near miss inside `AIM_CONE` remains usable on a moving deck.
   *
   * Range is measured to the nearest point of the box rather than to the ray's
   * entry, for the same reason: what decides whether a hand can reach a hatch
   * is how far away it is, not where a line happens to cross it.
   *
   * **Standing inside a target is not aim.** It used to score as zero angle and
   * zero distance, which let a floor box or hatch under the body win while the
   * player stared at a berth or up a mast. From inside a target we score toward
   * its centre instead. Every action therefore requires gaze alignment; being
   * nearby establishes reach, not intent.
   *
   * `reachableFrom` supplies the other half. A geometric ray happily continues
   * through a deck or bulkhead; the reach volume is the semantic occlusion that
   * says which side of that surface owns this particular target.
   */
  pick(
    eye: { x: number; y: number; z: number },
    direction: { x: number; y: number; z: number },
  ): ReachHit | null {
    let best: (ReachHit & { angle: number }) | null = null;
    const length = Math.hypot(direction.x, direction.y, direction.z);
    if (length < 1e-9) return null;
    const view = {
      x: direction.x / length,
      y: direction.y / length,
      z: direction.z / length,
    };

    for (const item of this.items) {
      const on = item.isOn();
      for (const target of item.targets(on)) {
        if (
          target.reachableFrom &&
          !target.reachableFrom.some((volume) => insideBox(eye, volume))
        ) {
          continue;
        }
        const box = target.box;
        const hit = rayBox(eye, view, box);
        // The nearest point is found in the box's own axes and brought back out,
        // because the *distance* to it survives a rotation and the *direction*
        // to it does not — and what the cone below scores is the direction.
        const inBox = turnAboutBox(eye, box, -1);
        const near = turnAboutBox(nearestPointInBox(inBox, box), box, 1);
        const range = Math.hypot(near.x - eye.x, near.y - eye.y, near.z - eye.z);
        if (range > REACH) continue;

        // A positive ray entry means the gaze crosses into the target. Zero is
        // different: the eye already occupies its interaction volume, which is
        // proximity and says nothing about where the player is looking.
        let angle = 0;
        if (hit === null || hit <= 1e-9) {
          // Toward the nearest part of it, which is the part a hand would go
          // to. Using the centre instead makes a wide hatch harder to name from
          // its own edge than from a stride away.
          //
          // From *inside*, however, nearest is the eye itself. The centre is
          // then the only point that carries directional information and stops
          // an occupied floor volume pretending it was deliberately aimed at.
          const aim =
            range <= 1e-9
              ? {
                  x: (box.xLo + box.xHi) / 2,
                  y: (box.yLo + box.yHi) / 2,
                  z: (box.zLo + box.zHi) / 2,
                }
              : near;
          const dx = aim.x - eye.x;
          const dy = aim.y - eye.y;
          const dz = aim.z - eye.z;
          const d = Math.hypot(dx, dy, dz);
          if (d < 1e-9) continue;
          const dot = (view.x * dx + view.y * dy + view.z * dz) / d;
          angle = Math.acos(Math.min(Math.max(dot, -1), 1));
        }
        if (angle > AIM_CONE) continue;

        const distance = range;
        if (
          best === null ||
          angle < best.angle - 1e-6 ||
          (Math.abs(angle - best.angle) <= 1e-6 && distance < best.distance)
        ) {
          best = { interactable: item, on, distance, angle };
        }
      }
    }
    if (!best) return null;
    return { interactable: best.interactable, on: best.on, distance: best.distance };
  }
}

/**
 * How far off the centre of view a thing may be and still be what you mean.
 *
 * 35°. Still forgiving enough for a hand-sized target on a moving ship, while
 * requiring the object to be in the part of the view the player is attending
 * to. Reach and room membership answer "can"; this cone answers "means".
 */
const AIM_CONE = (35 * Math.PI) / 180;

/** Is a position inside a box? Turned boxes are tested in their own axes. */
function insideBox(point: { x: number; y: number; z: number }, box: InteractableBox): boolean {
  const p = turnAboutBox(point, box, -1);
  return (
    p.x >= box.xLo &&
    p.x <= box.xHi &&
    p.y >= box.yLo &&
    p.y <= box.yHi &&
    p.z >= box.zLo &&
    p.z <= box.zHi
  );
}

/** The point of a box nearest a position — the box itself, if inside. */
function nearestPointInBox(
  point: { x: number; y: number; z: number },
  box: InteractableBox,
): { x: number; y: number; z: number } {
  return {
    x: Math.min(Math.max(point.x, box.xLo), box.xHi),
    y: Math.min(Math.max(point.y, box.yLo), box.yHi),
    z: Math.min(Math.max(point.z, box.zLo), box.zHi),
  };
}

/**
 * Ray against a box: the distance to the near face, or `null`.
 *
 * Zero when the eye is already inside, which is the useful answer — a player
 * standing in the hatchway is certainly within reach of the boards.
 *
 * A turned box is tested by turning the *ray* instead, which costs two lines and
 * keeps the slab test below exactly as it was. The distance it returns is still
 * in metres of ship, because a rotation does not change how long anything is.
 */
export function rayBox(
  origin: { x: number; y: number; z: number },
  direction: { x: number; y: number; z: number },
  box: InteractableBox,
): number | null {
  const start = turnAboutBox(origin, box, -1);
  const along = turnDirection(direction, box, -1);
  let near = 0;
  let far = Infinity;
  const axes: [number, number, number, number][] = [
    [start.x, along.x, box.xLo, box.xHi],
    [start.y, along.y, box.yLo, box.yHi],
    [start.z, along.z, box.zLo, box.zHi],
  ];
  for (const [o, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-9) {
      // Parallel to this slab: a miss unless the origin is already between its
      // faces. Without this branch a ray straight down a corridor misses every
      // box in it, because 0/0 is NaN and every comparison against NaN is false.
      if (o < lo || o > hi) return null;
      continue;
    }
    const t0 = (lo - o) / d;
    const t1 = (hi - o) / d;
    near = Math.max(near, Math.min(t0, t1));
    far = Math.min(far, Math.max(t0, t1));
    if (near > far) return null;
  }
  return far < 0 ? null : near;
}
