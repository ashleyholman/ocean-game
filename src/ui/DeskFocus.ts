import { sailingPlateSvg } from './sailingPlate';

/**
 * A thing off the desk, taking up the screen.
 *
 * WHY THIS IS A DOM OVERLAY AND NOT AN OBJECT THAT OPENS IN THE WORLD
 * ------------------------------------------------------------------
 * The book was always going to be the test of this and the answer was never
 * close. A page is *type* — a title, five labels on a diagram, a line of
 * instruction — and type on a texture, seen at the angle a seated player sees a
 * desk from, is type you cannot read. Every technique for fixing that is a
 * technique for approximating what a browser already does perfectly, at a cost
 * in texture memory and a cost in the one thing the page has to have, which is
 * legibility.
 *
 * Ash's own framing settled it before the argument started: *"opening it makes
 * the book take up the screen."* A thing that takes up the screen is not a thing
 * in the room.
 *
 * WHAT DOES NOT STOP
 * ------------------
 * The ship. She sails on while you read, the sea keeps running under her, and
 * the world clock — thirty times the wall clock — keeps spending your voyage.
 * That is deliberate and it is the one thing that makes reading a *choice*: a
 * paused game turns a manual into a menu, and a manual you have to decide to
 * open in the middle of a passage is a manual with weight.
 *
 * The frame behind is dimmed rather than hidden, for the same reason. You can
 * still see the cabin move.
 */

export type DeskFocusView = 'manual' | 'chronometer' | 'barometer';

/**
 * What the chronometer is told, each frame it is open.
 *
 * **The world's own numbers, not a copy of them.** `main.ts` hands this in as a
 * closure over the live clock and the live navigation telemetry, so the dial
 * cannot drift from the sun in the sky above the ship — which is the entire
 * claim the instrument makes and the only reason it was worth building rather
 * than drawing.
 */
export interface ChronometerReading {
  /** Greenwich time, seconds since the Unix epoch. */
  readonly utcSeconds: number;
  /** Where the ship is, east positive. `null` before the first fix. */
  readonly longitudeRad: number | null;
}

/**
 * What the glass is told, each frame it is open.
 *
 * The same contract as the chronometer's, and for the same reason: a closure
 * over the live `WeatherSystem`, not a copy of it. The gate WX1 sets itself is
 * that the reading on this face and the value in the committed weather series
 * are one number at the same instant, and the only way to be sure of that is
 * for there to be one number.
 */
export interface GlassReading {
  /** hPa. */
  readonly pressureHpa: number;
  /** The same pressure in the inches a period glass is graduated in. */
  readonly inchesOfMercury: number;
  /** hPa per three hours. Negative is falling. */
  readonly trendHpaPer3h: number;
  /** The word a log would use: 'falling', 'steady', 'rising slowly'… */
  readonly tendency: string;
}

export interface DeskFocusSources {
  readonly chronometer?: () => ChronometerReading;
  readonly barometer?: () => GlassReading;
}

/** How the manual is laid out: a run of spreads, turned one at a time. */
interface Spread {
  /** What the running head says. */
  readonly folio: string;
  readonly html: string;
}

/**
 * The manual, as pages.
 *
 * **Minimal words, and that is a constraint rather than a shortfall.** Ash asked
 * for it and a period working manual is genuinely like this: a plate, a caption,
 * and the assumption that the reader is a seaman. Every sentence here had to
 * earn its place against the drawing, which is why there are so few of them —
 * the plate says where she will go, and prose that repeats it is prose that
 * makes the plate look like it needed help.
 */
function manualSpreads(): readonly Spread[] {
  return [
    {
      folio: '',
      html:
        `<div class="page page--title">` +
        `<div class="page__rule"></div>` +
        `<p class="title__super">BEING A PLAIN ACCOUNT OF</p>` +
        `<h1 class="title__main">YE OLDE<br/>SAILING MANUAL</h1>` +
        `<p class="title__sub">THE POINTS OF SAILING, THE SETTING OF CANVAS,<br/>` +
        `AND THAT QUARTER WHEREIN NO VESSEL MAY GO</p>` +
        `<div class="page__rule"></div>` +
        `<p class="title__foot">PRINTED FOR THE MASTER &amp; HIS OFFICERS</p>` +
        `</div>`,
    },
    {
      folio: 'THE POINTS OF SAILING',
      html:
        `<div class="page page--plate">` +
        sailingPlateSvg() +
        `<p class="plate__caption">Sheets hard on the wind, eased as she bears away, ` +
        `squared off before it. She is fastest a little abaft the beam.</p>` +
        `</div>`,
    },
    {
      folio: 'OF THE WEDGE',
      html:
        `<div class="page page--text">` +
        `<h2>OF THAT QUARTER WHEREIN NO VESSEL MAY GO</h2>` +
        `<p>Within four points of the wind the canvas will not draw. She loses ` +
        `way, the rudder loses its bite, and she lies head to it: <em>in irons</em>.</p>` +
        `<h2>TO GAIN GROUND TO WINDWARD</h2>` +
        `<p>Sail as near as she will lie, first on one tack and then the other. ` +
        `The road to windward is a staircase and there is no other.</p>` +
        `<h2>TO COME ABOUT</h2>` +
        `<p>Carry way into the turn. A vessel put across the wind slowly is a ` +
        `vessel stopped in the middle of it.</p>` +
        `</div>`,
    },
  ];
}

/**
 * The chronometer's face, as one spread with nothing in it yet.
 *
 * **A spread with an empty body, rather than a second kind of view**, and that
 * is worth a sentence because the obvious design was a union. The overlay
 * already does everything this needs — it fades in over a dimmed frame, it takes
 * the screen, it has a running head, Space and Esc close it — and all of that is
 * written against `spreads`. A second branch would have had to reimplement the
 * lot to gain one difference: that the body is rewritten every second instead of
 * every page turn.
 *
 * So the chronometer is a one-page book whose page is redrawn by `tick`. The
 * pager hides itself when there is only one spread, which it already did.
 */
function chronometerSpreads(): readonly Spread[] {
  return [{ folio: 'THE MARINE TIMEKEEPER', html: '' }];
}

/** The glass's face. A one-page book, exactly as the chronometer is. */
function barometerSpreads(): readonly Spread[] {
  return [{ folio: 'THE GLASS', html: '' }];
}


/** The graduated range of a period marine glass, in inches of mercury. */
const GLASS_MIN_INHG = 28;
const GLASS_MAX_INHG = 31;
/** Degrees of arc the scale is swept over, centred on the top of the dial. */
const GLASS_SWEEP_DEG = 270;

/**
 * The words printed on the dial, at the pressures they were printed at.
 *
 * These are the real legends off an eighteenth-century wheel barometer, and
 * they are the reason the instrument was worth owning by someone who could not
 * read a millibar. They are also a quiet lesson in what the glass actually
 * tells you: the words sit at *pressures*, but a sailor reads the *movement*,
 * which is why the tendency is the largest thing on the page below.
 */
const GLASS_LEGENDS: ReadonlyArray<{ inHg: number; text: string }> = [
  { inHg: 28.3, text: 'STORMY' },
  { inHg: 28.9, text: 'MUCH RAIN' },
  { inHg: 29.4, text: 'RAIN' },
  { inHg: 29.9, text: 'CHANGE' },
  { inHg: 30.4, text: 'FAIR' },
  { inHg: 30.9, text: 'SET FAIR' },
];

/** Where on the dial a pressure sits, in radians clockwise from the top. */
function glassAngle(inchesOfMercury: number): number {
  const span = GLASS_MAX_INHG - GLASS_MIN_INHG;
  const t = Math.min(1, Math.max(0, (inchesOfMercury - GLASS_MIN_INHG) / span));
  return ((t - 0.5) * GLASS_SWEEP_DEG * Math.PI) / 180;
}

/**
 * Draw the glass.
 *
 * Two hands, and the difference between them is the instrument. The dark one
 * is the mercury and it is wherever the weather has put it. The brass one is
 * the **set-hand** — the pointer you turn by hand to mark where the glass stood
 * when you last looked — and it is left where it was when this face was opened.
 * So the gap between the two hands *is* how far the glass has moved since you
 * last came below, which is the only question anybody ever asked a barometer,
 * and it is the question WX1 exists to make answerable.
 */
function barometerFace(reading: GlassReading, setHandInHg: number): string {
  const R = 132;
  const needle = glassAngle(reading.inchesOfMercury);
  const setHand = glassAngle(setHandInHg);

  const hand = (
    angle: number,
    length: number,
    width: number,
    cls: string,
  ): string => {
    const x = Math.sin(angle) * length;
    const y = -Math.cos(angle) * length;
    const tailX = -Math.sin(angle) * length * 0.16;
    const tailY = Math.cos(angle) * length * 0.16;
    return (
      `<line class="${cls}" x1="${tailX.toFixed(2)}" y1="${tailY.toFixed(2)}" ` +
      `x2="${x.toFixed(2)}" y2="${y.toFixed(2)}" stroke-width="${width}" />`
    );
  };

  const ticks: string[] = [];
  const numerals: string[] = [];
  // A tenth of an inch is about 3.4 hPa and is the finest a wheel barometer is
  // ever graduated to; the numerals go on the half inch so they can be read.
  for (let step = 0; step <= 30; step++) {
    const inHg = GLASS_MIN_INHG + step * 0.1;
    const angle = glassAngle(inHg);
    const major = step % 5 === 0;
    const outer = R - 6;
    const inner = outer - (major ? 15 : 7);
    ticks.push(
      `<line class="dial__tick${major ? ' dial__tick--major' : ''}" ` +
        `x1="${(Math.sin(angle) * inner).toFixed(2)}" y1="${(-Math.cos(angle) * inner).toFixed(2)}" ` +
        `x2="${(Math.sin(angle) * outer).toFixed(2)}" y2="${(-Math.cos(angle) * outer).toFixed(2)}" />`,
    );
    if (major) {
      const r = R - 38;
      numerals.push(
        `<text class="dial__numeral" x="${(Math.sin(angle) * r).toFixed(2)}" ` +
          `y="${(-Math.cos(angle) * r).toFixed(2)}">${inHg.toFixed(1)}</text>`,
      );
    }
  }

  const legends = GLASS_LEGENDS.map(({ inHg, text }) => {
    const angle = glassAngle(inHg);
    const r = R - 62;
    return (
      `<text class="dial__legend" x="${(Math.sin(angle) * r).toFixed(2)}" ` +
        `y="${(-Math.cos(angle) * r).toFixed(2)}" ` +
        `transform="rotate(${((angle * 180) / Math.PI).toFixed(2)} ` +
        `${(Math.sin(angle) * r).toFixed(2)} ${(-Math.cos(angle) * r).toFixed(2)})">${text}</text>`
    );
  });

  const movedInHg = reading.inchesOfMercury - setHandInHg;
  const moved =
    Math.abs(movedInHg) < 0.005
      ? 'as you left it'
      : `${Math.abs(movedInHg).toFixed(2)} in ${movedInHg < 0 ? 'lower' : 'higher'} than you left it`;

  return [
    `<svg class="dial" viewBox="-150 -150 300 300" role="img" aria-label="the ship's barometer">`,
    `<circle class="dial__face" cx="0" cy="0" r="${R}" />`,
    ticks.join(''),
    numerals.join(''),
    legends.join(''),
    hand(setHand, R - 52, 3, 'dial__hand dial__hand--set'),
    hand(needle, R - 30, 5, 'dial__hand dial__hand--hour'),
    `<circle class="dial__boss" cx="0" cy="0" r="7" />`,
    '</svg>',
    `<p class="dial__caption">`,
    `<strong>${reading.inchesOfMercury.toFixed(2)} inches</strong> · `,
    `${reading.pressureHpa.toFixed(1)} hPa`,
    '</p>',
    `<p class="dial__caption dial__caption--large">${reading.tendency}`,
    `<span class="dial__aside"> — ${reading.trendHpaPer3h >= 0 ? '+' : ''}`,
    `${reading.trendHpaPer3h.toFixed(2)} hPa in three hours</span></p>`,
    `<p class="dial__caption dial__aside">The set-hand stands ${moved}.</p>`,
  ].join('');
}

const VIEWS: Record<DeskFocusView, () => readonly Spread[]> = {
  manual: manualSpreads,
  chronometer: chronometerSpreads,
  barometer: barometerSpreads,
};

/** What the way out of each view is called. */
const CLOSE_LABELS: Record<DeskFocusView, string> = {
  manual: 'Close the book',
  chronometer: 'Shut the case',
  barometer: 'Leave the glass',
};

const TWO_PI = Math.PI * 2;
const RAD_TO_DEG = 180 / Math.PI;

/** Two digits, which is what a clock face wants and what `padStart` is for. */
function pad(value: number): string {
  return Math.floor(value).toString().padStart(2, '0');
}

/**
 * A longitude as a navigator writes it: degrees, minutes, and a hand.
 *
 * Degrees and decimal minutes rather than degrees-minutes-seconds, because that
 * is what is written in a log and read off a chart, and because a third
 * sexagesimal place implies a precision no dead-reckoned position has.
 */
function formatLongitude(longitudeRad: number): string {
  const degrees = longitudeRad * RAD_TO_DEG;
  const hand = degrees >= 0 ? 'E' : 'W';
  const magnitude = Math.abs(degrees);
  const whole = Math.floor(magnitude);
  const minutes = (magnitude - whole) * 60;
  return `${whole}° ${minutes.toFixed(1)}′ ${hand}`;
}

/**
 * The hands, and what they are pointing at.
 *
 * **Mean time, and the page says so.** A real chronometer keeps mean time and
 * the sun keeps apparent time; the two differ by the equation of time, up to
 * about a quarter of an hour either way over a year. The world model has the
 * true solar position and could be asked, but the honest small version is to
 * show mean time and label it — a figure quietly called "local apparent time"
 * that is really mean time is worse than one that says which it is.
 */
function chronometerFace(reading: ChronometerReading): string {
  const utc = reading.utcSeconds;
  const secondsOfDay = ((utc % 86400) + 86400) % 86400;
  const hours = secondsOfDay / 3600;
  const minutes = (secondsOfDay % 3600) / 60;
  const seconds = secondsOfDay % 60;

  // A chronometer is a 24-hour instrument in use — you have to know whether
  // Greenwich is at breakfast or at supper — but its dial is a 12-hour one, so
  // the hour hand goes round twice and the caption below carries the whole clock.
  const hourAngle = ((hours % 12) / 12) * TWO_PI;
  const minuteAngle = (minutes / 60) * TWO_PI;
  const secondAngle = (seconds / 60) * TWO_PI;

  const R = 132;
  const hand = (angle: number, length: number, width: number, cls: string): string => {
    const x = Math.sin(angle) * length;
    const y = -Math.cos(angle) * length;
    const tailX = -Math.sin(angle) * length * 0.18;
    const tailY = Math.cos(angle) * length * 0.18;
    return (
      `<line class="${cls}" x1="${tailX.toFixed(2)}" y1="${tailY.toFixed(2)}" ` +
      `x2="${x.toFixed(2)}" y2="${y.toFixed(2)}" stroke-width="${width}" />`
    );
  };

  const ticks: string[] = [];
  for (let i = 0; i < 60; i++) {
    const angle = (i / 60) * TWO_PI;
    const major = i % 5 === 0;
    const outer = R - 6;
    const inner = outer - (major ? 15 : 7);
    ticks.push(
      `<line class="dial__tick${major ? ' dial__tick--major' : ''}" ` +
        `x1="${(Math.sin(angle) * inner).toFixed(2)}" y1="${(-Math.cos(angle) * inner).toFixed(2)}" ` +
        `x2="${(Math.sin(angle) * outer).toFixed(2)}" y2="${(-Math.cos(angle) * outer).toFixed(2)}" />`,
    );
  }
  const numerals: string[] = [];
  for (let i = 1; i <= 12; i++) {
    const angle = (i / 12) * TWO_PI;
    const r = R - 38;
    numerals.push(
      `<text class="dial__numeral" x="${(Math.sin(angle) * r).toFixed(2)}" ` +
        `y="${(-Math.cos(angle) * r).toFixed(2)}">${i}</text>`,
    );
  }

  // Local mean time and the longitude it implies. One hour of difference is
  // fifteen degrees, which is the whole of the method and is worth putting on
  // the page: it is why a ship carried a clock that cost as much as a boat.
  const longitude = reading.longitudeRad;
  const offsetHours = longitude === null ? null : (longitude * RAD_TO_DEG) / 15;
  const localSeconds =
    offsetHours === null ? null : (((secondsOfDay + offsetHours * 3600) % 86400) + 86400) % 86400;

  const greenwich = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  const local =
    localSeconds === null
      ? '—'
      : `${pad(localSeconds / 3600)}:${pad((localSeconds % 3600) / 60)}:${pad(localSeconds % 60)}`;

  return (
    `<div class="page page--dial">` +
    `<svg class="dial" viewBox="-150 -150 300 300" role="img" aria-label="Chronometer dial">` +
    `<circle class="dial__case" cx="0" cy="0" r="${R + 8}" />` +
    `<circle class="dial__face" cx="0" cy="0" r="${R}" />` +
    ticks.join('') +
    numerals.join('') +
    hand(hourAngle, R * 0.52, 7, 'dial__hand') +
    hand(minuteAngle, R * 0.78, 5, 'dial__hand') +
    hand(secondAngle, R * 0.84, 2, 'dial__hand dial__hand--second') +
    `<circle class="dial__boss" cx="0" cy="0" r="7" />` +
    `</svg>` +
    `<dl class="dial__readout">` +
    `<dt>Greenwich mean time</dt><dd>${greenwich}</dd>` +
    `<dt>Ship’s mean time</dt><dd>${local}</dd>` +
    `<dt>Longitude by the difference</dt>` +
    `<dd>${longitude === null ? '—' : formatLongitude(longitude)}</dd>` +
    `</dl>` +
    `<p class="dial__note">One hour of difference is fifteen degrees. ` +
    `Mean time, not apparent: the sun runs fast or slow of the clock by up to a ` +
    `quarter of an hour over the year.</p>` +
    `</div>`
  );
}

export class DeskFocus {
  private readonly root: HTMLElement;
  private readonly sheet: HTMLElement;
  private readonly folio: HTMLElement;
  private readonly pager: HTMLElement;
  private readonly back: HTMLButtonElement;
  private readonly forward: HTMLButtonElement;
  private view: DeskFocusView | null = null;
  private spreads: readonly Spread[] = [];
  private index = 0;
  private readonly sources: DeskFocusSources;
  /**
   * The whole second the face was last drawn for.
   *
   * **The dial is redrawn when the second changes, not when the frame does.**
   * `tick` is called out of `afterFrame`, so at 60 fps a naive implementation
   * rebuilds 300-odd SVG nodes sixty times a second to move a hand by six tenths
   * of a degree — and it does it while the ship is sailing and the sea is being
   * drawn behind the page. The world clock also runs at thirty times the wall
   * clock, so "a second" here is a second of *ship's* time and the hand does
   * move visibly; it just moves on the tick rather than continuously, which is
   * what a mechanical escapement does anyway.
   */
  /**
   * The last value drawn on a live face, quantised — seconds for the
   * chronometer, hundredths of an inch for the glass. One field because only
   * one live view is ever open.
   */
  private drawnSecond: number | null = null;
  /** Where the glass's brass set-hand stands. Null until it is first read. */
  private setHandInHg: number | null = null;

  constructor(parent: HTMLElement, sources: DeskFocusSources = {}) {
    this.sources = sources;
    this.root = document.createElement('div');
    this.root.className = 'deskfocus';
    this.root.hidden = true;

    this.sheet = document.createElement('div');
    this.sheet.className = 'deskfocus__sheet';

    this.folio = document.createElement('div');
    this.folio.className = 'deskfocus__folio';

    this.pager = document.createElement('div');
    this.pager.className = 'deskfocus__pager';
    this.back = this.pageButton('‹', -1);
    this.forward = this.pageButton('›', 1);
    this.pager.append(this.back, this.forward);

    this.root.append(this.folio, this.sheet, this.pager);
    parent.appendChild(this.root);

    // A swipe turns the page on touch, which is what a book is for. The
    // threshold is generous because the alternative gesture — a tap — already
    // has a job here, and a page turned by accident is cheaper than one that
    // will not turn.
    let startX: number | null = null;
    this.root.addEventListener('pointerdown', (e) => {
      startX = e.clientX;
    });
    this.root.addEventListener('pointerup', (e) => {
      if (startX === null) return;
      const dx = e.clientX - startX;
      startX = null;
      if (Math.abs(dx) > 60) this.turn(dx < 0 ? 1 : -1);
    });
  }

  private pageButton(glyph: string, delta: number): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'deskfocus__page';
    button.textContent = glyph;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.turn(delta);
      button.blur();
    });
    return button;
  }

  get openView(): DeskFocusView | null {
    return this.view;
  }

  /** What the action bar should call the way out of here. */
  get closeLabel(): string {
    return this.view === null ? 'Put it down' : CLOSE_LABELS[this.view];
  }

  open(view: DeskFocusView): void {
    this.view = view;
    this.spreads = VIEWS[view]();
    this.index = 0;
    this.drawnSecond = null;
    this.root.hidden = false;
    // Two frames' worth of separation between `hidden = false` and the class
    // that fades it in: a display change and a transition in the same frame is
    // a transition the browser skips, and the book would appear rather than
    // arrive.
    requestAnimationFrame(() => {
      if (this.view === view) this.root.classList.add('deskfocus--visible');
    });
    this.render();
  }

  /**
   * Advance anything on the open page that is alive. Called once a frame.
   *
   * Does nothing at all unless a live view is open, which is the common case —
   * a player who is not sitting at the desk pays one null check a frame for it.
   */
  tick(): void {
    if (this.view === 'chronometer') {
      const read = this.sources.chronometer;
      if (!read) return;
      const reading = read();
      const second = Math.floor(reading.utcSeconds);
      if (second === this.drawnSecond) return;
      this.drawnSecond = second;
      this.sheet.innerHTML = chronometerFace(reading);
      return;
    }
    if (this.view === 'barometer') {
      const read = this.sources.barometer;
      if (!read) return;
      const reading = read();
      // A hundredth of an inch is the finest the face resolves, so redraw on
      // that and not on every frame: the glass is a slow instrument and the
      // page is a full SVG rebuild.
      const hundredths = Math.round(reading.inchesOfMercury * 100);
      if (hundredths === this.drawnSecond) return;
      this.drawnSecond = hundredths;
      if (this.setHandInHg === null) this.setHandInHg = reading.inchesOfMercury;
      this.sheet.innerHTML = barometerFace(reading, this.setHandInHg);
    }
  }

  close(): void {
    if (this.view === null) return;
    // Leaving the glass sets its set-hand to where the mercury stands now, so
    // that the next look answers "how far has it moved since?" — which is what
    // a set-hand is and the only reason one is fitted.
    if (this.view === 'barometer') {
      const read = this.sources.barometer;
      if (read) this.setHandInHg = read().inchesOfMercury;
    }
    this.view = null;
    this.drawnSecond = null;
    this.root.classList.remove('deskfocus--visible');
    this.root.hidden = true;
  }

  turn(delta: number): void {
    if (this.view === null) return;
    const next = this.index + delta;
    if (next < 0 || next >= this.spreads.length) return;
    this.index = next;
    this.render();
  }

  private render(): void {
    const spread = this.spreads[this.index];
    if (!spread) return;
    this.sheet.innerHTML = spread.html;
    this.folio.textContent = spread.folio;
    this.back.disabled = this.index === 0;
    this.forward.disabled = this.index === this.spreads.length - 1;
    // Nothing to turn in a one-page view, and a pair of dead arrows under a
    // clock face is an interface offering something that is not there.
    this.pager.hidden = this.spreads.length <= 1;
    // A live page has no static html of its own; fill it now rather than
    // leaving it blank until the next whole second ticks over.
    this.tick();
  }

  dispose(): void {
    this.root.remove();
  }
}
