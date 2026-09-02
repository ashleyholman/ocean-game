/**
 * What this display, in this room, cannot show.
 *
 * WHY A CALIBRATION AND NOT A BRIGHTNESS SLIDER
 * ---------------------------------------------
 * Every other dial in the night thread asks "is the scene bright enough". This
 * one asks a question that is not in the scene at all: **where is this panel's
 * black?** Nothing the renderer can measure answers it, because the answer is
 * made of the panel's backlight leakage and the light in the player's room, and
 * both are outside the program.
 *
 * The difference matters in the interface as much as in the model. A slider
 * invites fiddling with the picture until it looks nice, which produces a
 * preference. This produces a MEASUREMENT: the player is shown a ladder of
 * patches at known sRGB codes on black and asked which is the faintest they can
 * still make out. That has a right answer for their setup, they can get it in
 * about five seconds, and the renderer can then trust it.
 *
 * WHAT THE RENDERER DOES WITH IT
 * ------------------------------
 * It re-derives Part A's scotopic lift. Ash subsequently rejected that observer
 * model and chose 0% as the shipped default, so this measurement no longer
 * changes the product picture. It remains the calibration for the explicit
 * `?scotopic=1` lab arm, where the operator still exists and still needs a real
 * display floor rather than Part A's assumed one. The player-facing entry point
 * is hidden unless that arm is enabled; a default session must not offer a
 * calibration that does nothing.
 *
 * Deliberately NOT a black-point lift on the whole picture. That would be the
 * other obvious use of the same number, and it would touch daylight — Part A's
 * bit-identical clause — to rescue shadow detail that is not what the round is
 * about. The floor is measured to size the night's lift, and the night is where
 * it is spent.
 */

import {
  SCOTOPIC_KNEE_HI,
  SCOTOPIC_LIFT_GAMMA,
  scotopicLift,
  scotopicStrength,
} from './scotopic';

/** sRGB encode, display-linear 0..1 to 0..1. */
export function srgbEncode(linear: number): number {
  const v = Math.min(Math.max(linear, 0), 1);
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** sRGB decode, 0..1 to display-linear 0..1. */
export function srgbDecode(encoded: number): number {
  const v = Math.min(Math.max(encoded, 0), 1);
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export const srgbCode = (linear: number): number =>
  Math.round(255 * srgbEncode(linear));
export const codeToLinear = (code: number): number => srgbDecode(code / 255);

/**
 * The display luminance of an ambient-lit night sea, measured in Part A at
 * -25 degrees sun through the real exposure meter and the real tone curve.
 *
 * This is the thing the lift is sized around: not the darkest pixel in the
 * frame but the one whose SHAPE has to read, which is the swell.
 */
export const NIGHT_SEA_DISPLAY_LUMINANCE = 0.0054;

/**
 * How far above invisibility the night sea's mean has to sit, in sRGB codes.
 *
 * CHOSEN. The sea is not a flat patch — it is a field with its own internal
 * contrast, and putting its MEAN exactly at the threshold would put half of it
 * underneath. 24 codes gives the swell's own light and dark sides room to
 * straddle the mean and still both be visible.
 */
export const CALIBRATION_TARGET_MARGIN_CODES = 24;

/**
 * The black floor Part A implicitly assumed, in sRGB codes. DERIVED, not
 * chosen: it is whatever floor makes the model below reproduce the shipping
 * `SCOTOPIC_LIFT_GAMMA` exactly, so an uncalibrated session is bit-identical to
 * Part A and a calibration only ever moves things by the amount it disagrees.
 *
 * It lands at about 15.5, which is roughly an uncalibrated laptop in a lit
 * room. Part A's guess was a good one; it was still a guess.
 */
export const CALIBRATION_REFERENCE_FLOOR_CODE =
  255 * srgbEncode(scotopicLift(NIGHT_SEA_DISPLAY_LUMINANCE, SCOTOPIC_LIFT_GAMMA)) -
  CALIBRATION_TARGET_MARGIN_CODES;

/**
 * The ladder the player is shown, in sRGB codes.
 *
 * Starts at 0 on purpose. That patch is drawn and is pure black, so a player
 * who reports seeing it has told us the measurement is unreliable rather than
 * that their display is extraordinary — a control, and the only guard available
 * against the strong human urge to see something where there is nothing.
 *
 * Roughly geometric above that, because the eye's discrimination near black is
 * a ratio, not a difference, and because the answers that matter are bunched
 * between 4 (a good panel in a dark room) and 30 (a laptop with a window
 * behind it).
 */
export const CALIBRATION_LADDER: readonly number[] = [
  0, 2, 3, 4, 6, 8, 11, 14, 18, 23, 29, 36, 45,
];

/** The strongest lift the model will ask for, whatever the floor measures. */
const MAX_LIFT_GAMMA = 4.0;

/**
 * The lift a display with this black floor needs, as the scotopic operator's
 * gamma.
 *
 * CLOSED FORM, from the operator's own shape. The lift is
 * `K^(1-1/g) * Y^(1/g)` where K is the photopic knee, so demanding that it
 * carry the night sea Y to a target T gives
 *
 *     g = ln(Y/K) / ln(T/K)
 *
 * with T the display luminance of `floor + CALIBRATION_TARGET_MARGIN_CODES`.
 * Nothing is fitted; the operator is inverted.
 */
export function liftGammaForBlackFloor(floorCode: number): number {
  const targetCode = Math.min(
    floorCode + CALIBRATION_TARGET_MARGIN_CODES,
    // Beyond the knee the operator retires, so a target above it is not
    // reachable by lifting and asking for one would return nonsense.
    255 * srgbEncode(SCOTOPIC_KNEE_HI) - 1,
  );
  const target = codeToLinear(targetCode);
  const gamma =
    Math.log(NIGHT_SEA_DISPLAY_LUMINANCE / SCOTOPIC_KNEE_HI) /
    Math.log(target / SCOTOPIC_KNEE_HI);
  return Math.min(Math.max(gamma, 1), MAX_LIFT_GAMMA);
}

// --- the stored measurement --------------------------------------------------

const STORAGE_KEY = 'drift.display.blackFloorCode';

export interface DisplayCalibration {
  /** The faintest sRGB code the player could still make out. */
  blackFloorCode: number;
  /** When it was taken, ISO. Shown back to them; nothing depends on it. */
  takenAt: string;
  /** True when the player reported seeing the pure-black control patch. */
  suspect: boolean;
}

let calibration: DisplayCalibration | null = null;
let loaded = false;
const listeners = new Set<() => void>();

function readOverride(): DisplayCalibration | null {
  if (typeof window === 'undefined') return null;
  const raw = new URLSearchParams(window.location.search).get('blackFloor');
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 64) {
    throw new Error(
      `[calibration] unknown ?blackFloor=${raw} — an sRGB code from 0 to 64`,
    );
  }
  return { blackFloorCode: value, takenAt: 'url', suspect: false };
}

function load(): void {
  if (loaded) return;
  loaded = true;
  const override = readOverride();
  if (override !== null) {
    calibration = override;
    return;
  }
  if (typeof localStorage === 'undefined') return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return;
    const parsed = JSON.parse(raw) as Partial<DisplayCalibration>;
    if (typeof parsed.blackFloorCode !== 'number') return;
    calibration = {
      blackFloorCode: parsed.blackFloorCode,
      takenAt: typeof parsed.takenAt === 'string' ? parsed.takenAt : 'unknown',
      suspect: parsed.suspect === true,
    };
  } catch {
    // A corrupt or unreadable store is an uncalibrated session, not a crash.
    calibration = null;
  }
}

/** The player's measurement, or null if they have never taken one. */
export function displayCalibration(): DisplayCalibration | null {
  load();
  return calibration;
}

export function setDisplayCalibration(next: DisplayCalibration | null): void {
  load();
  calibration = next;
  if (typeof localStorage !== 'undefined') {
    try {
      if (next === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Private browsing and full quotas both land here. The measurement still
      // applies to this session; it simply will not survive a reload.
    }
  }
  for (const listener of listeners) listener();
}

export function onDisplayCalibrationChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The optional scotopic lift this session should use when its strength is > 0.
 *
 * Callers deliberately do not invoke this on the shipping-off path, so a stale
 * local measurement or `?blackFloor=` cannot affect startup. An enabled,
 * uncalibrated lab session gets `SCOTOPIC_LIFT_GAMMA` itself, not a
 * re-derivation of it — the two agree to within 0.2% but "agree closely" is not
 * the claim being made, "unchanged" is.
 */
export function calibratedLiftGamma(): number {
  const measured = displayCalibration();
  return measured === null
    ? SCOTOPIC_LIFT_GAMMA
    : liftGammaForBlackFloor(measured.blackFloorCode);
}

/** One line for the settings page: what it concluded, in the player's terms. */
export function calibrationSummary(
  observerStrength: number = scotopicStrength(),
): string {
  if (observerStrength <= 0) {
    return (
      'Night-vision compensation is off. Display calibration is inactive and ' +
      'does not change the shipped picture.'
    );
  }
  const measured = displayCalibration();
  if (measured === null) {
    return 'Not calibrated — optional night vision assumes an average laptop in a lit room.';
  }
  const gamma = liftGammaForBlackFloor(measured.blackFloorCode);
  const reference = Math.round(CALIBRATION_REFERENCE_FLOOR_CODE);
  const verdict =
    measured.blackFloorCode <= reference - 6
      ? 'darker than average — a good panel, or a dark room'
      : measured.blackFloorCode >= reference + 6
        ? 'brighter than average — a bright room, or a panel that leaks'
        : 'about average';
  const change =
    gamma > SCOTOPIC_LIFT_GAMMA + 0.02
      ? 'so the optional night is lifted further than its uncalibrated setting'
      : gamma < SCOTOPIC_LIFT_GAMMA - 0.02
        ? 'so the optional night is lifted less than its uncalibrated setting'
        : 'which is what the optional model already assumed';
  return (
    `Your display goes black below level ${measured.blackFloorCode} of 255 — ` +
    `${verdict}, ${change}.`
  );
}
