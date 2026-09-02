import * as THREE from 'three';
import type { CameraSystem } from '../camera/CameraSystem';
import { REACH } from '../player/Interactables';

/**
 * Pointer, touch, wheel and keyboard input.
 *
 * Deliberately small: look, scale, a mode toggle, two binary actions and held
 * walking intent. There is no panning away from the vessel and nothing here
 * steers it.
 *
 * `CameraSystem` remains the single owner of what a camera drag means. This
 * controller reads its published mode only to allocate embodied touch roles;
 * it does not copy or infer camera state of its own.
 */

export interface InputCallbacks {
  /**
   * Raise or lower the DRIFT sail — the raft's one square of canvas, and the
   * kinematic speed target that goes with it.
   *
   * Optional, and absent on the production schooner. She has a rig of five
   * sails driven by trim, hoist and apparent wind, and `WindSystem.sail` is
   * not one of them: every read of that float goes to `Raft.ts`, and every
   * read of `sailRaised` goes to one word in a `?debug` panel. The key stayed
   * bound long after the vessel changed, so R did nothing anyone could see and
   * the hint line advertised it anyway.
   *
   * Absent means the global R key does nothing rather than doing something
   * invisible. Present exactly where the drift model is: the raft
   * (`?debug=raft`, `?debug=buoyancy`) and the schooner viewer
   * (`?debug=schooner`, `?debug=ship`), all three of which take their speed
   * from `WindSystem.targetDriftSpeedMps`. The object tap is the separate,
   * raft-only `onTapSail` callback below.
   */
  onToggleSail?: () => void;
  /**
   * Work the drift sail by pointing at its mast.
   *
   * Separate from `onToggleSail` because R is an intentionally global command,
   * while a tap names a particular object and therefore has an embodied reach
   * contract. The schooner viewer keeps the former and has no latter: it has no
   * raft sail or mast-pick segment to point at.
   */
  onTapSail?: () => void;
  onToggleMute: () => void;
  onFirstInteraction: () => void;
  /**
   * Work whatever the player is looking at, if anything is in reach.
   *
   * Space, and it took the key the sail used to have. The sail is a *global*
   * verb — press it anywhere aboard and the canvas moves — and that shape does
   * not survive an interior: the boards, the cabin door, the sea chest, the
   * chart drawers and the deadlights are all "open", and a key per object is
   * not a control scheme. So the key asks a question instead, and the answer is
   * whatever is under the crosshair within arm's reach.
   */
  onUse: () => void;
  /**
   * A click or tap that was *aimed at something*, in client pixels.
   *
   * **The same gesture on both platforms, and it has to be, because the seated
   * view is where it is used.** Sitting at the chart desk the player still
   * drags to look — the seat clamps the cone, it does not lock it — so a press
   * that turns into a drag is a look and a press that does not is a choice.
   * That is exactly the tap the double-tap and the sail already use, and it is
   * why this is a callback on the existing tap path rather than a `click`
   * listener: a `click` fires at the end of a drag too, so a player who looked
   * around and let go would have picked up a book.
   *
   * Returns whether the press was consumed. Anything that is not consumed falls
   * through to the double-tap, so a tap on empty water still changes the view.
   */
  onSelect?: (clientX: number, clientY: number) => boolean;
  /** Whether embodied touch input has a walkable body to drive. */
  touchWalkingEnabled?: boolean;
}

type PointerRole = 'camera' | 'touch-walk' | 'touch-look' | 'ignored';

interface PointerState {
  x: number;
  y: number;
  startX: number;
  startY: number;
  startTime: number;
  moved: boolean;
  role: PointerRole;
}

/** Keys the walk reads. Held state, not events. */
const MOVEMENT_KEYS = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);

/** Text-entry controls, which legitimately own every key while focused. */
function isTextEntry(target: HTMLElement | null): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  if (target.tagName === 'TEXTAREA') return true;
  if (target.tagName !== 'INPUT') return false;
  const type = (target as HTMLInputElement).type;
  return !/^(range|checkbox|radio|button|submit|reset|color)$/.test(type);
}

const TAP_MAX_MS = 400;
const TAP_MAX_PX = 10;
const DOUBLE_TAP_MAX_MS = 320;
const DOUBLE_TAP_MAX_PX = 30;
/** Below this projected mast height the sail is no longer a tap target. */
const MAST_PICK_MIN_PX = 20;
/** A resting thumb may wander this far without walking the body. */
const TOUCH_WALK_DEAD_ZONE_PX = 10;
const TOUCH_WALK_MIN_RADIUS_PX = 56;
const TOUCH_WALK_MAX_RADIUS_PX = 96;
const TOUCH_WALK_VIEWPORT_FRACTION = 0.12;

export class InputController {
  private readonly pointers = new Map<number, PointerState>();
  private pinchDistance = 0;
  private hadInteraction = false;
  private lastTapTime = 0;
  private lastTapX = 0;
  private lastTapY = 0;
  private walkPointerId: number | undefined;
  private lookPointerId: number | undefined;

  /** World-space endpoints of the mast, used for tap picking. */
  readonly pickLow = new THREE.Vector3();
  readonly pickHigh = new THREE.Vector3();

  private readonly ndcA = new THREE.Vector3();
  private readonly ndcB = new THREE.Vector3();
  private readonly cameraSpaceA = new THREE.Vector3();
  private readonly cameraSpaceB = new THREE.Vector3();
  private readonly mastLine = new THREE.Line3();
  private readonly nearestMastPoint = new THREE.Vector3();

  /**
   * Held movement keys.
   *
   * Walking is the one input in this project that is a *state* rather than an
   * event: everything else here is a gesture that happens once. Keys held down
   * are read by the frame loop instead of dispatched, so a dropped keyup cannot
   * leave the player walking forever — a key that is no longer down stops
   * appearing in this set the moment the browser says so, and losing focus
   * clears it outright.
   */
  private readonly heldKeys = new Set<string>();

  constructor(
    private readonly element: HTMLElement,
    private readonly cameras: CameraSystem,
    private readonly callbacks: InputCallbacks,
  ) {
    element.addEventListener('pointerdown', this.onPointerDown, { passive: false });
    element.addEventListener('pointermove', this.onPointerMove, { passive: false });
    element.addEventListener('pointerup', this.onPointerUp);
    element.addEventListener('pointercancel', this.onPointerCancel);
    element.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    element.addEventListener('contextmenu', preventDefault);
  }

  dispose(): void {
    const e = this.element;
    e.removeEventListener('pointerdown', this.onPointerDown);
    e.removeEventListener('pointermove', this.onPointerMove);
    e.removeEventListener('pointerup', this.onPointerUp);
    e.removeEventListener('pointercancel', this.onPointerCancel);
    e.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    e.removeEventListener('contextmenu', preventDefault);
    this.clearPointerState();
    this.heldKeys.clear();
  }

  private markInteraction(): void {
    if (!this.hadInteraction) {
      this.hadInteraction = true;
      this.callbacks.onFirstInteraction();
    }
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    event.preventDefault();
    // Capture keeps a drag alive outside the canvas, but it throws for a
    // pointer the browser no longer considers active — which must not take the
    // rest of this handler down with it.
    try {
      this.element.setPointerCapture(event.pointerId);
    } catch {
      /* not capturable; dragging still works, just not past the edge */
    }
    const role = this.pointerRole(event);
    this.pointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      startTime: performance.now(),
      moved: false,
      role,
    });
    if (role === 'touch-walk') this.walkPointerId = event.pointerId;
    if (role === 'touch-look') this.lookPointerId = event.pointerId;
    if (this.cameras.modeName === 'cinematic' && this.pointers.size === 2) {
      this.pinchDistance = this.currentPinchDistance();
    }
    this.markInteraction();
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const state = this.pointers.get(event.pointerId);
    if (!state) return;
    event.preventDefault();

    const dx = event.clientX - state.x;
    const dy = event.clientY - state.y;
    state.x = event.clientX;
    state.y = event.clientY;

    if (Math.hypot(event.clientX - state.startX, event.clientY - state.startY) > TAP_MAX_PX) {
      state.moved = true;
    }

    if (state.role === 'touch-walk' || state.role === 'ignored') {
      return;
    }
    if (state.role === 'touch-look') {
      this.cameras.drag(
        dx,
        dy,
        this.element.clientWidth || 1,
        this.element.clientHeight || 1,
      );
    } else if (this.pointers.size === 1 || this.cameras.modeName === 'embodied') {
      this.cameras.drag(
        dx,
        dy,
        this.element.clientWidth || 1,
        this.element.clientHeight || 1,
      );
    } else if (this.pointers.size === 2) {
      const d = this.currentPinchDistance();
      if (this.pinchDistance > 1 && d > 1) {
        // Pinch is a ratio; the cinematic scale is logarithmic, so the natural
        // mapping is the log of that ratio. Spreading the fingers by the same
        // factor therefore changes the scale by the same amount wherever you
        // are on the curve.
        this.cameras.zoomBy(Math.log(this.pinchDistance / d) * PINCH_GAIN);
      }
      this.pinchDistance = d;
    }
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    const state = this.pointers.get(event.pointerId);
    this.releasePointer(event.pointerId);
    if (!state) return;
    if (state.role === 'ignored') return;

    const elapsed = performance.now() - state.startTime;
    if (state.moved || elapsed >= TAP_MAX_MS) return;

    // The object callback first. It exists only where the active vessel has a
    // drift sail *and* publishes a mast target; keeping it separate from the
    // global R callback means the schooner viewer cannot acquire a remote tap
    // merely because its diagnostic speed still uses the legacy drift verb.
    const tapSail = this.callbacks.onTapSail;
    if (tapSail && this.hitsSail(event.clientX, event.clientY)) {
      tapSail();
      this.lastTapTime = 0;
      return;
    }

    // Before the double-tap, because a book on the desk is a smaller and more
    // deliberate target than "the empty water", and a player picking one up
    // twice in quick succession must not find themselves outside the hull.
    if (this.callbacks.onSelect?.(event.clientX, event.clientY)) {
      this.lastTapTime = 0;
      return;
    }

    // Double-tap changes the view. Touch has no `V`, and a permanent on-screen
    // mode button is exactly the kind of HUD this scene does without — so the
    // gesture goes on the empty water, where nothing else is listening.
    const now = performance.now();
    const near =
      Math.hypot(event.clientX - this.lastTapX, event.clientY - this.lastTapY) <
      DOUBLE_TAP_MAX_PX;
    if (now - this.lastTapTime < DOUBLE_TAP_MAX_MS && near) {
      this.lastTapTime = 0;
      this.clearTouchGestures();
      this.cameras.toggleMode();
      return;
    }
    this.lastTapTime = now;
    this.lastTapX = event.clientX;
    this.lastTapY = event.clientY;
  };

  /** Cancellation ends a gesture; it is never a tap. */
  private readonly onPointerCancel = (event: PointerEvent): void => {
    this.releasePointer(event.pointerId);
  };

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.markInteraction();
    // `deltaY` is only in pixels when `deltaMode` says so. Firefox reports
    // lines (deltaMode 1, deltaY about 3 per notch) and some configurations
    // report pages, so treating the raw number as pixels makes one notch move
    // the scale by 0.0014 there — several hundred notches to cross the range.
    const pixels =
      event.deltaMode === 1
        ? event.deltaY * WHEEL_LINE_PIXELS
        : event.deltaMode === 2
          ? event.deltaY * (this.element.clientHeight || WHEEL_PAGE_PIXELS)
          : event.deltaY;
    this.cameras.zoomBy(THREE.MathUtils.clamp(pixels, -120, 120) * WHEEL_GAIN);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat) return;
    const target = event.target as HTMLElement | null;
    // Typing must never steer the ship. But a *slider* is not typing, and
    // treating it as though it were is how a panel took the keyboard hostage:
    // one drag of a developer slider left it focused, this test then discarded
    // every key, and the walk stopped responding with no visible cause. The
    // controls give focus back when they are released, and this is the second
    // half of that fix — only a control you can put text into gets to win.
    if (isTextEntry(target)) return;
    // Space and Enter activate whatever control has focus. Let them, rather
    // than raising the sail every time a button is used with the keyboard.
    if (
      (event.code === 'Space' || event.code === 'Enter') &&
      target &&
      /^(INPUT|BUTTON|SELECT)$/.test(target.tagName)
    ) {
      return;
    }
    if (event.code === 'Space') {
      // **Space is "use what you are looking at" now, not the sail.** Ash's
      // call. The sail moved to R rather than sharing: two verbs on one key
      // means the key does whichever the code checked first, which is a control
      // that behaves differently depending on where you stand.
      event.preventDefault();
      this.markInteraction();
      this.callbacks.onUse();
    } else if (event.code === 'KeyR' && this.callbacks.onToggleSail) {
      // `markInteraction` stays inside the guard. It is what starts the audio
      // context on the first gesture, and a key that is not bound on this
      // vessel should not be the thing that counts as the player arriving.
      this.markInteraction();
      this.callbacks.onToggleSail();
    } else if (event.code === 'KeyM') {
      this.markInteraction();
      this.callbacks.onToggleMute();
    } else if (event.code === 'KeyV') {
      this.markInteraction();
      this.clearTouchGestures();
      this.lastTapTime = 0;
      this.cameras.toggleMode();
    } else if (MOVEMENT_KEYS.has(event.code)) {
      // Arrow keys scroll the page; the canvas fills it, so that is a scroll to
      // nowhere that also eats the keystroke.
      event.preventDefault();
      this.markInteraction();
      this.heldKeys.add(event.code);
    }
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.heldKeys.delete(event.code);
  };

  /** Losing focus mid-stride must not leave a key or thumb held down forever. */
  private readonly onBlur = (): void => {
    this.heldKeys.clear();
    this.clearPointerState();
  };

  /**
   * Movement intent, −1 to 1 on each axis, relative to where the player looks.
   *
   * Read rather than dispatched: the walk is integrated by the frame loop, and
   * an event-driven walk would move by a variable amount per keystroke repeat.
   */
  movementAxes(): { forward: number; right: number } {
    const held = this.heldKeys;
    let forward =
      (held.has('KeyW') || held.has('ArrowUp') ? 1 : 0) -
      (held.has('KeyS') || held.has('ArrowDown') ? 1 : 0);
    let right =
      (held.has('KeyD') || held.has('ArrowRight') ? 1 : 0) -
      (held.has('KeyA') || held.has('ArrowLeft') ? 1 : 0);
    const touch = this.touchMovementAxes();
    forward = THREE.MathUtils.clamp(forward + touch.forward, -1, 1);
    right = THREE.MathUtils.clamp(right + touch.right, -1, 1);
    return { forward, right };
  }

  /**
   * Embodied touch is a pair of unmarked thumb regions: left walks, right
   * looks. The visual teaching affordance is deliberately a later UI item;
   * this class owns only the gesture and its safe cancellation.
   */
  private pointerRole(event: PointerEvent): PointerRole {
    if (
      event.pointerType !== 'touch' ||
      this.cameras.modeName !== 'embodied' ||
      !this.callbacks.touchWalkingEnabled
    ) {
      return 'camera';
    }
    const rect = this.element.getBoundingClientRect();
    if (event.clientX < rect.left + rect.width / 2) {
      return this.walkPointerId === undefined ? 'touch-walk' : 'ignored';
    }
    return this.lookPointerId === undefined ? 'touch-look' : 'ignored';
  }

  private touchMovementAxes(): { forward: number; right: number } {
    if (this.cameras.modeName !== 'embodied' || this.walkPointerId === undefined) {
      return { forward: 0, right: 0 };
    }
    const state = this.pointers.get(this.walkPointerId);
    if (!state) return { forward: 0, right: 0 };
    const dx = state.x - state.startX;
    const dy = state.y - state.startY;
    const distance = Math.hypot(dx, dy);
    if (distance <= TOUCH_WALK_DEAD_ZONE_PX) return { forward: 0, right: 0 };
    const radius = THREE.MathUtils.clamp(
      Math.min(this.element.clientWidth, this.element.clientHeight) *
        TOUCH_WALK_VIEWPORT_FRACTION,
      TOUCH_WALK_MIN_RADIUS_PX,
      TOUCH_WALK_MAX_RADIUS_PX,
    );
    const magnitude = THREE.MathUtils.clamp(
      (distance - TOUCH_WALK_DEAD_ZONE_PX) /
        (radius - TOUCH_WALK_DEAD_ZONE_PX),
      0,
      1,
    );
    return {
      forward: (-dy / distance) * magnitude,
      right: (dx / distance) * magnitude,
    };
  }

  private releasePointer(pointerId: number): void {
    this.pointers.delete(pointerId);
    if (this.walkPointerId === pointerId) this.walkPointerId = undefined;
    if (this.lookPointerId === pointerId) this.lookPointerId = undefined;
    try {
      this.element.releasePointerCapture(pointerId);
    } catch {
      /* already released */
    }
    if (this.pointers.size < 2) this.pinchDistance = 0;
  }

  private clearTouchGestures(): void {
    for (const [pointerId, state] of this.pointers) {
      if (state.role === 'touch-walk' || state.role === 'touch-look' || state.role === 'ignored') {
        this.pointers.delete(pointerId);
      }
    }
    this.walkPointerId = undefined;
    this.lookPointerId = undefined;
    this.pinchDistance = 0;
  }

  private clearPointerState(): void {
    this.pointers.clear();
    this.walkPointerId = undefined;
    this.lookPointerId = undefined;
    this.pinchDistance = 0;
  }

  private currentPinchDistance(): number {
    const it = this.pointers.values();
    const a = it.next().value;
    const b = it.next().value;
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  /**
   * Screen-space hit test against the mast axis.
   *
   * The sail is deformed entirely in its vertex shader, so its rest geometry is
   * a poor raycast proxy. Projecting the mast segment and measuring pixel
   * distance to it is both cheaper and a better match for what the player sees.
   * Before projection the segment is clipped to the camera's visible depth:
   * looking down past the raft can put the masthead behind the eye while its
   * base remains plainly drawn, and the visible base must remain a target.
   */
  private hitsSail(clientX: number, clientY: number): boolean {
    const rect = this.element.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const camera = this.cameras.camera;

    // A tap on a drawn mast is an object action, not the raft's global R
    // command. It therefore starts at the embodied eye and stops at the same
    // arm-and-step reach used by the ship registry. Cinematic inspection can
    // still use R, but cannot work canvas from across the sea.
    if (this.cameras.modeName !== 'embodied') return false;
    this.mastLine.set(this.pickLow, this.pickHigh);
    this.mastLine.closestPointToPoint(camera.position, true, this.nearestMastPoint);
    if (this.nearestMastPoint.distanceToSquared(camera.position) > REACH * REACH) {
      return false;
    }

    // Clip in camera space, where visible depth is simply -Z in [near, far].
    // Rejecting when *either* original endpoint was outside discarded the
    // entire mast at ordinary downward looks: the base was on screen and the
    // masthead had crossed behind the eye. The interpolation parameter is the
    // same in camera and world space, so it can trim the published endpoints
    // before their ordinary perspective projection.
    this.cameraSpaceA.copy(this.pickLow).applyMatrix4(camera.matrixWorldInverse);
    this.cameraSpaceB.copy(this.pickHigh).applyMatrix4(camera.matrixWorldInverse);
    const depthA = -this.cameraSpaceA.z;
    const depthB = -this.cameraSpaceB.z;
    const depthDelta = depthB - depthA;
    let tLo = 0;
    let tHi = 1;
    if (Math.abs(depthDelta) < 1e-9) {
      if (depthA < camera.near || depthA > camera.far) return false;
    } else {
      const tNear = (camera.near - depthA) / depthDelta;
      const tFar = (camera.far - depthA) / depthDelta;
      tLo = Math.max(0, Math.min(tNear, tFar));
      tHi = Math.min(1, Math.max(tNear, tFar));
      if (tLo > tHi) return false;
    }
    this.ndcA.copy(this.pickLow).lerp(this.pickHigh, tLo).project(camera);
    this.ndcB.copy(this.pickLow).lerp(this.pickHigh, tHi).project(camera);

    const ax = ((this.ndcA.x + 1) / 2) * w;
    const ay = ((1 - this.ndcA.y) / 2) * h;
    const bx = ((this.ndcB.x + 1) / 2) * w;
    const by = ((1 - this.ndcB.y) / 2) * h;

    const px = clientX - rect.left;
    const py = clientY - rect.top;

    const vx = bx - ax;
    const vy = by - ay;
    const lenSq = vx * vx + vy * vy;
    const mastPixels = Math.sqrt(lenSq);
    // Past the point where the mast is a few pixels tall there is nothing to
    // aim at, and a fixed radius would mean a tap anywhere near the middle of
    // the sea raised the sail from a kilometre away.
    if (mastPixels < MAST_PICK_MIN_PX) return false;

    let t = lenSq > 0 ? ((px - ax) * vx + (py - ay) * vy) / lenSq : 0;
    t = Math.min(1, Math.max(0, t));
    const dist = Math.hypot(px - (ax + vx * t), py - (ay + vy * t));

    // Generous, and more generous still on a small screen where it is a finger
    // — but never wider than the target itself is tall, so the picking radius
    // shrinks with the raft as the cinematic camera pulls away.
    const threshold = Math.min(
      Math.max(38, Math.min(w, h) * 0.085),
      Math.max(24, mastPixels * 0.6),
    );
    return dist < threshold;
  }
}

/**
 * Wheel and pinch gains, in units of cinematic scale.
 *
 * One 120-unit wheel notch moves the scale by 0.055, so the whole range from a
 * close inspection to 1.4 km is about eighteen notches — enough that the middle
 * of the range is reachable deliberately, few enough that getting to either end
 * is not a chore.
 */
const WHEEL_GAIN = 0.055 / 120;
const PINCH_GAIN = 0.42;
/** Conventional pixels per wheel line and per page, for `deltaMode` 1 and 2. */
const WHEEL_LINE_PIXELS = 16;
const WHEEL_PAGE_PIXELS = 800;

function preventDefault(event: Event): void {
  event.preventDefault();
}
