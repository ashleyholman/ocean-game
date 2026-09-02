/**
 * One line of translucent text that appears briefly and then leaves nothing
 * behind. This is the entire interface.
 */

/**
 * Space is no longer the sail — it works whatever is in front of you. The hint
 * says so once; after that `ActionBar` names the verb at the moment there is
 * something to use, which is a better teacher than a line of text at the start
 * of a voyage.
 *
 * THE SAIL CLAUSE IS CONDITIONAL, AND IT TOOK A ROUND TO NOTICE
 * -------------------------------------------------------------
 * "R for the sail" outlived the raft. On the schooner R reached
 * `WindSystem.toggleSail`, whose only readers are the raft's canvas and one
 * word in a `?debug` panel — so the first thing the game said about itself was
 * a control that moves nothing. Desktop R remains in the diagnostic raft and
 * schooner viewer because both use the drift-speed command. The touch clause is
 * narrower: only the raft publishes the physical mast target that a nearby,
 * embodied player can tap. Her own five sails are trimmed by the crew rather
 * than by a key, so nothing takes its place.
 */
const DESKTOP_BASE = [
  'Drag to look',
  'Scroll to change scale',
  'V to change view',
  'Space to use',
] as const;
const DESKTOP_SAIL = 'R for the sail';
const DESKTOP_SOUND = 'M for sound';
const TOUCH_BASE = [
  'Drag to look',
  'Pinch to change scale',
  'Double-tap to change view',
] as const;
const TOUCH_SAIL = 'Tap the sail to raise it';

const SEPARATOR = '  ·  ';

export interface HintOptions {
  /**
   * Whether this platform has an available drift-sail control to advertise.
   * Desktop means global R; touch means the raft's spatial mast tap.
   *
   * Defaults to false. The production schooner is the common case, and a hint
   * that over-promises when nobody passes the flag is exactly the failure this
   * parameter exists to prevent.
   */
  driftSail?: boolean;
}

/** The line a given platform and vessel actually gets. Exported for the test. */
export function hintText(touch: boolean, driftSail: boolean): string {
  if (touch) {
    return [...TOUCH_BASE, ...(driftSail ? [TOUCH_SAIL] : [])].join(SEPARATOR);
  }
  return [
    ...DESKTOP_BASE,
    ...(driftSail ? [DESKTOP_SAIL] : []),
    DESKTOP_SOUND,
  ].join(SEPARATOR);
}

export class Hint {
  private readonly element: HTMLElement;
  private timer: number | undefined;
  private removed = false;

  constructor(element: HTMLElement, touch: boolean, options: HintOptions = {}) {
    this.element = element;
    element.textContent = hintText(touch, options.driftSail === true);

    // Let the scene establish itself for a beat before the text arrives.
    window.setTimeout(() => {
      if (!this.removed) element.classList.add('hint--visible');
    }, 900);

    this.timer = window.setTimeout(() => this.hide(), 9500);
  }

  hide(): void {
    if (this.removed) return;
    this.removed = true;
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.element.classList.remove('hint--visible');
    // Take it out of the document entirely once the transition has run.
    window.setTimeout(() => this.element.remove(), 2600);
  }
}
