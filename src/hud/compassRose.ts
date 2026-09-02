/**
 * The steering instrument: one compass card, one course order, one rudder.
 *
 * This is the developer crew HUD's compass with everything a developer needs
 * taken off it — no perceived-vs-indicated split, no sixty-second trace, no
 * intervention log, no tiller-load gauge. What is left is what a person at the
 * wheel can actually see: where the bow is pointing, where they asked it to
 * point, and what the helmsman is doing with the rudder to close the gap.
 *
 * The card turns and the lubber line is fixed, like a real card — the heading
 * under the mark at the top is the ship's heading, and the brass diamond
 * drifting around the ring is the standing order she is being steered to.
 */

import { HUD_ACCENT, HUD_INK, HUD_MUTED } from './hudStyle';

/** Logical drawing size; the canvas backing store is this times `SCALE`. */
export const COMPASS_WIDTH = 320;
export const COMPASS_HEIGHT = 262;
const SCALE = 2;

export interface CompassReading {
  /** True heading of the bow, degrees. */
  headingDeg: number;
  /** The standing course order, or null when nobody is holding a course. */
  orderedCourseDeg: number | null;
  /** Where the blade actually is, degrees, positive to port. */
  rudderBladeDeg: number;
  /** Where the helmsman has asked for it, degrees, positive to port. */
  rudderOrderDeg: number;
  /** Mechanical hard-over limit, degrees. */
  rudderLimitDeg: number;
  /** Compass bearing the true wind blows *from*, or null in a calm. */
  windFromDeg: number | null;
}

const CENTRE_X = COMPASS_WIDTH / 2;
// Sized so the whole page — card, rudder, readout and the sail controls —
// stands up in one panel without hunting for it.
const CENTRE_Y = 100;
const RADIUS = 78;

/** Size the canvas for the device pixel grid once, before the first draw. */
export function prepareCompassCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = COMPASS_WIDTH * SCALE;
  canvas.height = COMPASS_HEIGHT * SCALE;
}

export function drawCompassRose(
  canvas: HTMLCanvasElement,
  reading: CompassReading,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.save();
  ctx.scale(SCALE, SCALE);
  ctx.clearRect(0, 0, COMPASS_WIDTH, COMPASS_HEIGHT);
  ctx.font = '600 11px ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif';

  drawCard(ctx, reading.headingDeg, reading.orderedCourseDeg);
  drawWind(ctx, reading.headingDeg, reading.windFromDeg);
  drawLubber(ctx);
  drawCentreReadout(ctx, reading);
  drawRudder(ctx, reading);

  ctx.restore();
}

/** The rotating card: the heading under the lubber mark sits at the top. */
function drawCard(
  ctx: CanvasRenderingContext2D,
  headingDeg: number,
  orderedCourseDeg: number | null,
): void {
  ctx.save();
  ctx.translate(CENTRE_X, CENTRE_Y);

  ctx.strokeStyle = 'rgba(190, 214, 232, 0.22)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(0, 0, RADIUS + 7, 0, Math.PI * 2);
  ctx.stroke();

  for (let bearing = 0; bearing < 360; bearing += 10) {
    const angle = ((bearing - headingDeg - 90) * Math.PI) / 180;
    const major = bearing % 30 === 0;
    const inner = RADIUS - (major ? 13 : 7);
    ctx.strokeStyle = major
      ? 'rgba(220, 232, 242, 0.85)'
      : 'rgba(180, 202, 220, 0.34)';
    ctx.lineWidth = major ? 1.6 : 1;
    ctx.beginPath();
    ctx.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
    ctx.lineTo(Math.cos(angle) * RADIUS, Math.sin(angle) * RADIUS);
    ctx.stroke();
    if (!major) continue;
    const cardinal = CARDINALS[bearing];
    ctx.fillStyle = bearing === 0 ? '#df8d78' : HUD_MUTED;
    ctx.font = cardinal
      ? '700 13px ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif'
      : '600 10px ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(
      cardinal ?? String(bearing / 10),
      Math.cos(angle) * (RADIUS - 25),
      Math.sin(angle) * (RADIUS - 25),
    );
  }

  if (orderedCourseDeg !== null) {
    const angle = ((orderedCourseDeg - headingDeg - 90) * Math.PI) / 180;
    ctx.strokeStyle = 'rgba(232, 184, 113, 0.34)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(angle) * (RADIUS - 6), Math.sin(angle) * (RADIUS - 6));
    ctx.stroke();
    ctx.save();
    ctx.translate(Math.cos(angle) * RADIUS, Math.sin(angle) * RADIUS);
    ctx.rotate(angle + Math.PI / 2);
    ctx.fillStyle = HUD_ACCENT;
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(5.5, 0);
    ctx.lineTo(0, 7);
    ctx.lineTo(-5.5, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  ctx.restore();
}

/**
 * Where the wind is coming from, outside the ring.
 *
 * An arrow pointing *inward*, because that is what a wind does: it arrives.
 * It sits in the margin outside the card so it never competes with the course
 * order on the ring itself, and it turns with the card — read it against the
 * bow at the top and you have the angle you are sailing at, without doing any
 * arithmetic.
 */
function drawWind(
  ctx: CanvasRenderingContext2D,
  headingDeg: number,
  windFromDeg: number | null,
): void {
  if (windFromDeg === null) return;
  const angle = ((windFromDeg - headingDeg - 90) * Math.PI) / 180;
  ctx.save();
  ctx.translate(CENTRE_X, CENTRE_Y);
  ctx.rotate(angle);
  // Local frame: +x points out along the wind's bearing, so the arrow is
  // authored once, pointing back toward the centre.
  ctx.strokeStyle = WIND_COLOUR;
  ctx.fillStyle = WIND_COLOUR;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(RADIUS + 20, 0);
  ctx.lineTo(RADIUS + 8, 0);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(RADIUS + 5, 0);
  ctx.lineTo(RADIUS + 12, -4.5);
  ctx.lineTo(RADIUS + 12, 4.5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** The fixed mark the card turns under — the bow, always at the top. */
function drawLubber(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#f2e6c8';
  ctx.beginPath();
  ctx.moveTo(CENTRE_X, CENTRE_Y - RADIUS - 4);
  ctx.lineTo(CENTRE_X - 7, CENTRE_Y - RADIUS - 16);
  ctx.lineTo(CENTRE_X + 7, CENTRE_Y - RADIUS - 16);
  ctx.closePath();
  ctx.fill();
}

function drawCentreReadout(
  ctx: CanvasRenderingContext2D,
  reading: CompassReading,
): void {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = HUD_INK;
  ctx.font =
    '700 30px ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.fillText(bearingText(reading.headingDeg), CENTRE_X, CENTRE_Y + 6);
  ctx.font =
    '600 9.5px ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.fillStyle = HUD_MUTED;
  ctx.fillText('HEADING', CENTRE_X, CENTRE_Y + 21);
  ctx.fillStyle = HUD_ACCENT;
  ctx.fillText(
    reading.orderedCourseDeg === null
      ? 'NO STANDING ORDER'
      : `ORDERED ${bearingText(reading.orderedCourseDeg)}`,
    CENTRE_X,
    CENTRE_Y + 38,
  );
  if (reading.windFromDeg !== null) {
    // Outside the ring, not stacked under the course order: at four lines the
    // centre stack reaches the card's own numerals and the two collide.
    ctx.fillStyle = WIND_COLOUR;
    ctx.fillText(
      `WIND FROM ${bearingText(reading.windFromDeg)}`,
      CENTRE_X,
      CENTRE_Y + RADIUS + 24,
    );
  }
}

/**
 * The rudder, as the one thing a passenger can see the helmsman doing.
 *
 * The bar is the blade's real angle; the tick is where the hand has asked for
 * it. They separate whenever the helmsman moves, and close again as the gear
 * catches up — which is the whole visible story of someone steering.
 */
function drawRudder(
  ctx: CanvasRenderingContext2D,
  reading: CompassReading,
): void {
  const y = COMPASS_HEIGHT - 30;
  const left = 34;
  const right = COMPASS_WIDTH - 34;
  const centre = (left + right) / 2;
  const limit = Math.max(reading.rudderLimitDeg, 1);
  const at = (deg: number): number =>
    centre + (clamp(deg, -limit, limit) / limit) * (right - centre);

  ctx.strokeStyle = 'rgba(190, 214, 232, 0.22)';
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(left, y);
  ctx.lineTo(right, y);
  ctx.stroke();

  ctx.strokeStyle = '#6ea9d2';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(centre, y);
  ctx.lineTo(at(reading.rudderBladeDeg), y);
  ctx.stroke();

  ctx.strokeStyle = HUD_ACCENT;
  ctx.lineWidth = 2;
  ctx.lineCap = 'butt';
  const order = at(reading.rudderOrderDeg);
  ctx.beginPath();
  ctx.moveTo(order, y - 9);
  ctx.lineTo(order, y + 9);
  ctx.stroke();

  ctx.fillStyle = HUD_MUTED;
  ctx.font =
    '600 9.5px ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('STBD', left - 4, y + 24);
  ctx.textAlign = 'right';
  ctx.fillText('PORT', right + 4, y + 24);
  ctx.textAlign = 'center';
  ctx.fillStyle = HUD_INK;
  ctx.fillText(
    Math.abs(reading.rudderBladeDeg) < 0.5
      ? 'RUDDER AMIDSHIPS'
      : `RUDDER ${Math.abs(reading.rudderBladeDeg).toFixed(0)}° ` +
        (reading.rudderBladeDeg > 0 ? 'PORT' : 'STARBOARD'),
    centre,
    y - 16,
  );
}

/** Cold and pale against the brass of the course order — never confusable. */
const WIND_COLOUR = '#8fc6e8';

const CARDINALS: Readonly<Record<number, string>> = {
  0: 'N',
  90: 'E',
  180: 'S',
  270: 'W',
};

function bearingText(deg: number): string {
  const wrapped = ((Math.round(deg) % 360) + 360) % 360;
  return `${String(wrapped).padStart(3, '0')}°`;
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}
