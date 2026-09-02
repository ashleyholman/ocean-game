/**
 * The player-facing interface for "what can I do right now".
 *
 * WHAT THIS REPLACED, AND WHY IT HAD TO GROW
 * ------------------------------------------
 * `UsePrompt` was one line naming one thing within reach, and its own note gave
 * the reason it was contextual rather than a permanent button: *a floating
 * action button that is always there has to be greyed out most of the time,
 * which teaches the player that the control is usually useless.* That argument
 * is still the whole design and none of it changed.
 *
 * What changed is that the ship acquired a state in which the thing you can do
 * is **not** a thing in front of you. Sitting at the chart desk, the reach pick
 * is deliberately dead — see `main.ts` — so a prompt driven only by the pick
 * showed nothing at all, and a player who sat down could not get up again. One
 * line could not express it, because the seated view has *two* things you might
 * do at once: stand up, and shut whatever you have open on the desk.
 *
 * So: nought to two actions, and the same DOM on both platforms.
 *
 * WHY THE SAME DOM ON BOTH PLATFORMS
 * ----------------------------------
 * The old prompt built a `<div>` on desktop and a `<button>` on touch, which
 * was right when the only question was whether the line could be tapped.
 * Ash asked for buttons at the bottom of the screen on mobile — "might make it
 * easier" — and the temptation was to build that as a phone-only control surface
 * beside the desktop line.
 *
 * It is one control on both, for two reasons. A mobile-only surface is a second
 * layout to keep in step with the first, and this project has paid for a second
 * description of one thing in every round since the rig. And more simply: a
 * labelled button that also says which key it is bound to is *better on
 * desktop*, not a concession to touch. "Stand up · Space" is a sentence; the
 * key hint is what makes it one.
 *
 * The buttons are real buttons everywhere; on desktop they also carry their key,
 * and pressing the key does the same thing as clicking.
 */

export interface PlayerAction {
  /** A stable identity, so the bar can tell a changed label from a changed action. */
  readonly id: string;
  /** What the player is told they can do, in the state the thing is in now. */
  readonly label: string;
  /** The key that does it, for the desktop hint. */
  readonly key: string;
  perform(): void;
}

/** How many actions the bar will ever show at once. */
const MAX_ACTIONS = 2;

export class ActionBar {
  private readonly element: HTMLElement;
  private readonly buttons: HTMLButtonElement[] = [];
  private readonly actions: (PlayerAction | undefined)[] = [];
  private visible = false;

  constructor(parent: HTMLElement, private readonly touch: boolean) {
    this.element = document.createElement('div');
    this.element.className = 'actionbar';
    for (let i = 0; i < MAX_ACTIONS; i++) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'actionbar__action';
      button.hidden = true;
      button.addEventListener('click', (event) => {
        event.preventDefault();
        this.actions[i]?.perform();
        // A button that keeps focus eats the next Space, and Space is the very
        // key most of these stand in for. `InputController` already refuses keys
        // aimed at a focused BUTTON, so the fix belongs here.
        button.blur();
      });
      this.buttons.push(button);
      this.actions.push(undefined);
      this.element.appendChild(button);
    }
    parent.appendChild(this.element);
  }

  /**
   * Called every frame with everything the player could do, most important
   * first. Anything past the second is dropped — see `MAX_ACTIONS`.
   */
  show(actions: readonly PlayerAction[]): void {
    const shown = actions.slice(0, MAX_ACTIONS);
    for (let i = 0; i < MAX_ACTIONS; i++) {
      const action = shown[i];
      const button = this.buttons[i];
      const previous = this.actions[i];
      this.actions[i] = action;
      if (!action) {
        if (previous) button.hidden = true;
        continue;
      }
      // Only touch the DOM when the sentence actually changed. This runs every
      // frame, and a `textContent` write per frame is a layout per frame.
      if (!previous || previous.label !== action.label || previous.key !== action.key) {
        button.textContent = this.touch ? action.label : `${action.label}  ·  ${action.key}`;
      }
      button.hidden = false;
    }

    const wanted = shown.length > 0;
    if (wanted !== this.visible) {
      this.visible = wanted;
      this.element.classList.toggle('actionbar--visible', wanted);
    }
  }

  dispose(): void {
    this.element.remove();
  }
}
