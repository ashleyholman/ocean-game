/**
 * Control builders for the player-facing interface.
 *
 * Same contract as the developer panels' `ControlGroup` and for the same two
 * hard-won reasons, which are worth restating because they are not obvious:
 *
 *  - every control pulls its displayed value back from the model each frame,
 *    because the model is the truth and anything that only pushes will
 *    silently disagree the moment something else moves the same value;
 *  - every control gives the keyboard back when it is done with it. A focused
 *    `input[type=range]` eats the arrow keys, so a player who nudges a slider
 *    and then cannot walk does not think "the slider has focus" — they think
 *    the game is broken.
 *
 * The controls are bigger and fewer than the developer ones. Everything here
 * is sized for a thumb.
 */

import { ensureHudStyle } from './hudStyle';

export interface HudSliderOptions {
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

export interface HudSegmentedOption<T extends string> {
  value: T;
  label: string;
}

function releaseFocus(element: HTMLElement): void {
  element.blur();
}

/** A page of controls: builds the DOM and owns the read-back closures. */
export class HudGroup {
  readonly element: HTMLElement;
  private readonly syncers: Array<() => void> = [];

  constructor(className = 'hud-page') {
    ensureHudStyle();
    this.element = document.createElement('div');
    this.element.className = className;
  }

  section(text: string): void {
    const div = document.createElement('div');
    div.className = 'hud-section';
    div.textContent = text;
    this.element.appendChild(div);
  }

  note(text: string): HTMLParagraphElement {
    const p = document.createElement('p');
    p.className = 'hud-note';
    p.textContent = text;
    this.element.appendChild(p);
    return p;
  }

  slider(options: HudSliderOptions): HTMLInputElement {
    const field = document.createElement('label');
    field.className = 'hud-field';
    const row = document.createElement('div');
    row.className = 'hud-row';
    const name = document.createElement('span');
    name.className = 'hud-name';
    name.textContent = options.label;
    const value = document.createElement('span');
    value.className = 'hud-value';
    value.textContent = options.format(options.value);
    row.append(name, value);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(options.min);
    input.max = String(options.max);
    input.step = String(options.step);
    input.value = String(options.value);
    input.setAttribute('aria-label', options.label);
    input.addEventListener('input', () => {
      const next = Number(input.value);
      value.textContent = options.format(next);
      options.onChange(next);
    });

    let committed = Number(input.value);
    const commit = (): void => {
      const next = Number(input.value);
      if (next !== committed) {
        options.onCommit?.(next);
        committed = next;
      }
      releaseFocus(input);
    };
    input.addEventListener('pointerup', commit);
    input.addEventListener('change', commit);

    field.append(row, input);
    this.element.appendChild(field);

    const read = options.read;
    if (read) {
      this.syncers.push(() => {
        if (document.activeElement === input) return;
        const current = read();
        // The *text* always follows the model, so a clock reads as a clock —
        // it ticks between handle positions instead of jumping a whole step at
        // a time. The handle only moves when it would actually land somewhere
        // else, which keeps a dragged slider from fighting the hand on it.
        value.textContent = options.format(current);
        if (Math.abs(current - Number(input.value)) < options.step * 0.5) return;
        input.value = String(current);
        committed = current;
      });
    }
    return input;
  }

  /** Evenly spaced, presentational reference marks for the preceding slider. */
  sliderMarkers(labels: readonly string[]): HTMLDivElement {
    const markers = document.createElement('div');
    markers.className = 'hud-slider-markers';
    markers.setAttribute('aria-hidden', 'true');
    const last = labels.length - 1;
    for (const [index, label] of labels.entries()) {
      const marker = document.createElement('span');
      marker.textContent = label;
      marker.style.left = `${last > 0 ? (index / last) * 100 : 0}%`;
      markers.appendChild(marker);
    }
    this.element.appendChild(markers);
    return markers;
  }

  /**
   * A row of mutually exclusive choices — the player-facing radio group.
   *
   * `busy` is for choices that are *orders* rather than switches: the work
   * takes the crew real time, so the chosen button carries a progress fill
   * until they have finished it. Without it the interface claims the ship
   * changed the instant the button was pressed, and then appears not to have.
   */
  segmented<T extends string>(
    label: string,
    options: readonly HudSegmentedOption<T>[],
    onChange: (value: T) => void,
    read: () => T,
    busy?: () => { value: T; fraction: number } | null,
  ): void {
    const field = document.createElement('div');
    field.className = 'hud-field';
    const row = document.createElement('div');
    row.className = 'hud-row';
    const name = document.createElement('span');
    name.className = 'hud-name';
    name.textContent = label;
    row.append(name);

    const group = document.createElement('div');
    group.className = 'hud-seg';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', label);
    const buttons = options.map((option) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = option.label;
      button.setAttribute('aria-pressed', String(read() === option.value));
      button.addEventListener('click', () => {
        onChange(option.value);
        this.sync();
        releaseFocus(button);
      });
      group.appendChild(button);
      return { button, value: option.value };
    });

    field.append(row, group);
    this.element.appendChild(field);
    this.syncers.push(() => {
      const current = read();
      const working = busy?.() ?? null;
      for (const entry of buttons) {
        entry.button.setAttribute('aria-pressed', String(entry.value === current));
        if (working && entry.value === working.value) {
          entry.button.dataset.busy = 'true';
          entry.button.style.setProperty(
            '--hud-progress',
            `${Math.round(Math.min(Math.max(working.fraction, 0), 1) * 100)}%`,
          );
          entry.button.setAttribute('aria-busy', 'true');
        } else {
          delete entry.button.dataset.busy;
          entry.button.style.removeProperty('--hud-progress');
          entry.button.removeAttribute('aria-busy');
        }
      }
    });
  }

  select(
    label: string,
    options: ReadonlyArray<{ value: string; label: string }>,
    onChange: (value: string) => void,
    read: () => string,
  ): void {
    const field = document.createElement('label');
    field.className = 'hud-field';
    const row = document.createElement('div');
    row.className = 'hud-row';
    const name = document.createElement('span');
    name.className = 'hud-name';
    name.textContent = label;
    row.append(name);

    const select = document.createElement('select');
    select.className = 'hud-select';
    for (const option of options) {
      const element = document.createElement('option');
      element.value = option.value;
      element.textContent = option.label;
      select.appendChild(element);
    }
    select.value = read();
    select.addEventListener('change', () => {
      onChange(select.value);
      releaseFocus(select);
    });

    field.append(row, select);
    this.element.appendChild(field);
    this.syncers.push(() => {
      if (document.activeElement === select) return;
      const current = read();
      if (select.value !== current) select.value = current;
    });
  }

  toggle(
    label: string,
    onChange: (on: boolean) => void,
    read: () => boolean,
  ): void {
    const field = document.createElement('label');
    field.className = 'hud-switch';
    const name = document.createElement('span');
    name.className = 'hud-name';
    name.textContent = label;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = read();
    const track = document.createElement('span');
    track.className = 'hud-track';
    input.addEventListener('change', () => {
      onChange(input.checked);
      releaseFocus(input);
    });
    field.append(name, input, track);
    this.element.appendChild(field);
    this.syncers.push(() => {
      if (document.activeElement === input) return;
      input.checked = read();
    });
  }

  buttons(items: ReadonlyArray<{ label: string; onClick: () => void; title?: string }>): void {
    const row = document.createElement('div');
    row.className = 'hud-buttons';
    for (const item of items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = item.label;
      if (item.title) button.title = item.title;
      button.addEventListener('click', () => {
        item.onClick();
        this.sync();
        releaseFocus(button);
      });
      row.appendChild(button);
    }
    this.element.appendChild(row);
  }

  /** A big headline number with a unit beside it. */
  stat(unit: string): HTMLSpanElement {
    const row = document.createElement('div');
    row.className = 'hud-stat';
    const big = document.createElement('span');
    big.className = 'hud-big';
    big.textContent = '—';
    const suffix = document.createElement('span');
    suffix.className = 'hud-unit';
    suffix.textContent = unit;
    row.append(big, suffix);
    this.element.appendChild(row);
    return big;
  }

  lines(): HTMLPreElement {
    const pre = document.createElement('pre');
    pre.className = 'hud-lines';
    this.element.appendChild(pre);
    return pre;
  }

  canvas(width: number, height: number, ariaLabel: string): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.className = 'hud-canvas';
    canvas.width = width;
    canvas.height = height;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', ariaLabel);
    this.element.appendChild(canvas);
    return canvas;
  }

  /**
   * The twelve month letters under a day-of-year slider, as the developer
   * world panel has always had them.
   *
   * Positioned by real day number rather than by twelfths, so February is
   * narrow and every mark sits under the day the handle would. Rebuilt when
   * the year changes, because a leap year moves every mark after February.
   */
  monthMarkers(year: number): HTMLDivElement {
    const markers = document.createElement('div');
    markers.className = 'hud-months';
    this.fillMonthMarkers(markers, year);
    this.element.appendChild(markers);
    return markers;
  }

  fillMonthMarkers(markers: HTMLElement, year: number): void {
    markers.replaceChildren();
    markers.dataset.year = String(year);
    const days =
      (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86_400_000;
    for (let month = 0; month < 12; month++) {
      const marker = document.createElement('span');
      marker.textContent = new Date(
        Date.UTC(year, month, 1),
      ).toLocaleDateString('en-AU', { month: 'narrow', timeZone: 'UTC' });
      marker.style.left = `${
        ((Date.UTC(year, month, 1) - Date.UTC(year, 0, 1)) /
          86_400_000 /
          (days - 1)) *
        100
      }%`;
      markers.appendChild(marker);
    }
  }

  sync(): void {
    for (const syncer of this.syncers) syncer();
  }
}

/** Compass bearing as sailors write it: three digits and a degree sign. */
export function formatBearing(deg: number): string {
  const wrapped = ((Math.round(deg) % 360) + 360) % 360;
  return `${String(wrapped).padStart(3, '0')}°`;
}

/** Metres per second in the unit a player has a feel for. */
export function metresPerSecondToKnots(mps: number): number {
  return mps * 1.943_844_49;
}
