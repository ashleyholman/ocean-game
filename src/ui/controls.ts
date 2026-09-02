/**
 * Small control builders shared by the developer panels.
 *
 * Every control registers a `sync` closure that pulls its displayed value back
 * from the model each frame. That direction matters: the model is the truth,
 * and a slider that only ever pushes will silently disagree with it the moment
 * anything else — a preset button, a transition, a keyboard shortcut — moves
 * the same value. A focused slider is left alone so it does not fight the hand
 * currently dragging it.
 */

export const PANEL_STYLE = `
.devpanel {
  position: fixed; z-index: 50;
  width: min(320px, calc(100vw - 24px));
  max-height: calc(100vh - 84px);
  overflow-y: auto; overscroll-behavior: contain;
  padding: 10px 12px 14px; border-radius: 7px;
  background: rgba(8, 14, 22, 0.90); color: #cfd8e3;
  border: 1px solid rgba(255, 255, 255, 0.13);
  font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  backdrop-filter: blur(9px);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
}
.devpanel[hidden] { display: none; }
.devpanel h2 {
  margin: 0 0 8px; font-size: 10px; font-weight: 600;
  letter-spacing: 0.10em; text-transform: uppercase; color: #7f9bb5;
}
.devpanel .sec {
  margin: 13px 0 5px; padding-top: 7px;
  border-top: 1px solid rgba(255, 255, 255, 0.09);
  font-size: 9.5px; letter-spacing: 0.13em; text-transform: uppercase;
  color: #6d8ba6;
}
.devpanel label { display: block; margin: 7px 0 0; }
.devpanel .row { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
.devpanel .row span:last-child { color: #8fb7d8; font-variant-numeric: tabular-nums; }
.devpanel input[type='range'] { width: 100%; accent-color: #6f9ec4; margin-top: 2px; }
.devpanel .checkbox-row { display: flex; align-items: center; gap: 8px; color: #9eb4c7; margin-top: 7px; }
.devpanel input[type='checkbox'] { accent-color: #6f9ec4; }
.devpanel select, .devpanel input[type='number'] {
  width: 100%; margin-top: 3px; padding: 4px 5px;
  background: rgba(255, 255, 255, 0.05); color: #dbe6f0;
  border: 1px solid rgba(255, 255, 255, 0.13); border-radius: 4px;
  font: inherit;
}
.devpanel .buttons { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
.devpanel .buttons button {
  flex: 1 1 auto; padding: 5px 7px; border-radius: 4px;
  background: rgba(255, 255, 255, 0.05); color: #dbe6f0;
  border: 1px solid rgba(255, 255, 255, 0.13); cursor: pointer; font: inherit;
}
.devpanel .buttons button:hover { background: rgba(120, 175, 220, 0.20); }
.devpanel pre {
  margin: 9px 0 0; padding-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.09);
  white-space: pre-wrap; color: #9fb6cb;
  font-variant-numeric: tabular-nums; font-size: 10.5px; line-height: 1.45;
}
`;

export interface SliderOptions {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
  /** Pointer/key release after the last live `input` update. */
  onCommit?: (value: number) => void;
  /** Pull the current value back from the model. */
  read?: () => number;
}

/**
 * Give the keyboard back to the game.
 *
 * Every control in this file is a control *over* something the player is
 * simultaneously driving with the keyboard, so none of them may keep focus once
 * they have been used. A focused `input[type=range]` consumes the arrow keys
 * outright and leaves the panel as the keyboard's owner; the walk then silently
 * stops working, which is exactly what it looks like — a bug in the walk.
 */
function releaseFocus(this: HTMLElement): void {
  this.blur();
}

export class ControlGroup {
  readonly element: HTMLElement;
  private readonly syncers: Array<() => void> = [];

  constructor(root: HTMLElement) {
    this.element = root;
  }

  section(text: string): void {
    const div = document.createElement('div');
    div.className = 'sec';
    div.textContent = text;
    this.element.appendChild(div);
  }

  /** Returns the row's root element so a caller can show/hide it by mode. */
  slider(options: SliderOptions): HTMLLabelElement {
    const label = document.createElement('label');
    const row = document.createElement('div');
    row.className = 'row';
    const name = document.createElement('span');
    name.textContent = options.label;
    const value = document.createElement('span');
    value.textContent = options.format(options.value);
    row.append(name, value);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(options.min);
    input.max = String(options.max);
    input.step = String(options.step);
    input.value = String(options.value);
    input.addEventListener('input', () => {
      const next = Number(input.value);
      value.textContent = options.format(next);
      options.onChange(next);
    });
    // A slider keeps focus after it is dragged, and a focused range input eats
    // every arrow key and swallows the rest. On a panel that sits over a game
    // being played with the keyboard that is not a nuisance, it is a dead
    // player: Ash moved one slider and could not walk again. Releasing the
    // pointer hands the keyboard back.
    let committedValue = Number(input.value);
    const commit = (): void => {
      const next = Number(input.value);
      if (next !== committedValue) {
        options.onCommit?.(next);
        committedValue = next;
      }
      releaseFocus.call(input);
    };
    input.addEventListener('pointerup', commit);
    input.addEventListener('change', commit);

    label.append(row, input);
    this.element.appendChild(label);

    const read = options.read;
    if (read) {
      this.syncers.push(() => {
        if (document.activeElement === input) return;
        const current = read();
        if (Math.abs(current - Number(input.value)) < options.step * 0.5) return;
        input.value = String(current);
        value.textContent = options.format(current);
      });
    }
    return label;
  }

  checkbox(
    labelText: string,
    initial: boolean,
    onChange: (checked: boolean) => void,
    read?: () => boolean,
  ): void {
    const label = document.createElement('label');
    label.className = 'checkbox-row';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = initial;
    input.addEventListener('change', () => {
      onChange(input.checked);
      releaseFocus.call(input);
    });
    const span = document.createElement('span');
    span.textContent = labelText;
    label.append(input, span);
    this.element.appendChild(label);
    if (read) this.syncers.push(() => { input.checked = read(); });
  }

  select(
    labelText: string,
    options: Array<{ value: string; label: string }>,
    initial: string,
    onChange: (value: string) => void,
    read?: () => string,
  ): void {
    const label = document.createElement('label');
    const row = document.createElement('div');
    row.className = 'row';
    const name = document.createElement('span');
    name.textContent = labelText;
    row.append(name);
    const select = document.createElement('select');
    for (const option of options) {
      const el = document.createElement('option');
      el.value = option.value;
      el.textContent = option.label;
      select.appendChild(el);
    }
    select.value = initial;
    select.addEventListener('change', () => {
      onChange(select.value);
      releaseFocus.call(select);
    });
    label.append(row, select);
    this.element.appendChild(label);
    if (read) {
      this.syncers.push(() => {
        if (document.activeElement === select) return;
        const current = read();
        if (select.value !== current) select.value = current;
      });
    }
  }

  buttons(items: Array<{ label: string; onClick: () => void; title?: string }>): void {
    const div = document.createElement('div');
    div.className = 'buttons';
    for (const item of items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = item.label;
      if (item.title) button.title = item.title;
      button.addEventListener('click', () => {
        item.onClick();
        releaseFocus.call(button);
      });
      div.appendChild(button);
    }
    this.element.appendChild(div);
  }

  readout(): HTMLPreElement {
    const pre = document.createElement('pre');
    this.element.appendChild(pre);
    return pre;
  }

  sync(): void {
    for (const syncer of this.syncers) syncer();
  }
}

/** Install the shared panel stylesheet exactly once. */
let styleInstalled = false;
export function ensurePanelStyle(): void {
  if (styleInstalled) return;
  styleInstalled = true;
  const style = document.createElement('style');
  style.textContent = PANEL_STYLE;
  document.head.appendChild(style);
}
