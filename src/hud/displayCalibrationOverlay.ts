/**
 * The calibration, as an act.
 *
 * Five seconds of black, a ladder of patches, one click. It is deliberately a
 * FULL-SCREEN MODAL rather than a control on the settings page, and the shape
 * is the argument: a slider sits next to the picture and invites the player to
 * adjust the scene until it looks nice, which yields a preference. This covers
 * the picture entirely and asks a question with a right answer — which of these
 * can you actually see — which yields a measurement the renderer can trust.
 *
 * THREE THINGS THE FORM HAS TO GET RIGHT
 * --------------------------------------
 * 1. THE EYE HAS TO SETTLE. A measurement of near-black taken two seconds after
 *    looking at a lit interface measures the interface, not the display. Hence
 *    the wait before the ladder appears. Five seconds is not real dark
 *    adaptation — that is twenty minutes — but it is the difference between a
 *    reading and a guess, and it is short enough that nobody skips it.
 * 2. NOTHING BRIGHT NEAR THE PATCHES. A caption beside a level-3 patch destroys
 *    the reading of that patch. All the text is dim, and all of it is far from
 *    the ladder; the patches themselves carry no labels at all.
 * 3. THERE HAS TO BE A CONTROL. The leftmost patch is pure black and nothing is
 *    drawn there. A player who picks it has told us the reading is unreliable,
 *    which is worth knowing, because the urge to see something where there is
 *    nothing is strong and this is the only guard available against it.
 */

import {
  CALIBRATION_LADDER,
  setDisplayCalibration,
} from '../scene/displayCalibration';
import { scotopicStrength } from '../scene/scotopic';

/** Seconds of black before the ladder appears. */
const SETTLE_SECONDS = 5;

const INK = '#5d7183';
const INK_BRIGHT = '#9db3c6';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style: Partial<CSSStyleDeclaration>,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node.style, style);
  if (text !== undefined) node.textContent = text;
  return node;
}

export interface CalibrationOverlayHandle {
  close(): void;
}

/**
 * Run the calibration. Resolves when the player has answered or cancelled;
 * the measurement is stored through `setDisplayCalibration` either way.
 */
export function openDisplayCalibration(
  onDone?: () => void,
): CalibrationOverlayHandle {
  const root = el('div', {
    position: 'fixed',
    inset: '0',
    // Pure black, and it must stay pure: everything measured here is measured
    // against it, so no gradient, no vignette, no near-black tint.
    background: '#000',
    zIndex: '9999',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0',
    font: '13px/1.6 ui-sans-serif, system-ui, sans-serif',
    color: INK,
    userSelect: 'none',
    cursor: 'default',
  });

  const title = el(
    'div',
    {
      color: INK_BRIGHT,
      fontSize: '15px',
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      marginBottom: '10px',
    },
    'Calibrating your display',
  );

  const instruction = el(
    'div',
    {
      maxWidth: '30em',
      textAlign: 'center',
      marginBottom: '48px',
    },
    'Set your screen to the brightness you actually play at, and sit where you actually sit.',
  );

  // Reserved so the ladder's arrival does not shift the text above it.
  const stage = el('div', {
    height: '132px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  });

  const settling = el(
    'div',
    { color: INK, opacity: '0.75' },
    'Let your eyes settle…',
  );
  stage.appendChild(settling);

  const footer = el(
    'div',
    {
      marginTop: '48px',
      opacity: '0.55',
      textAlign: 'center',
      maxWidth: '34em',
    },
    '',
  );

  root.append(title, instruction, stage, footer);

  let closed = false;
  let attempts = 0;
  const timers: number[] = [];

  const close = (): void => {
    if (closed) return;
    closed = true;
    for (const timer of timers) window.clearTimeout(timer);
    window.removeEventListener('keydown', onKey);
    root.remove();
    onDone?.();
  };

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') close();
  }
  window.addEventListener('keydown', onKey);

  const conclude = (code: number, suspect: boolean): void => {
    setDisplayCalibration({
      blackFloorCode: code,
      takenAt: new Date().toISOString(),
      suspect,
    });
    stage.replaceChildren(
      el(
        'div',
        { color: INK_BRIGHT, textAlign: 'center' },
        suspect
          ? `Recorded as level ${code}, but treat it as rough — the black patch was reported visible.`
          : `Your display goes black below level ${code} of 255.`,
      ),
    );
    instruction.textContent =
      scotopicStrength() > 0
        ? 'Optional night vision is now calibrated for this display.'
        : 'Measurement saved. Night-vision compensation is off, so the picture is unchanged.';
    footer.textContent = 'You can change this any time from Settings.';
    timers.push(window.setTimeout(close, 2600));
  };

  const showLadder = (): void => {
    if (closed) return;
    instruction.textContent =
      'Click the leftmost square you can still make out. If you can see none of them, click the one on the right.';
    footer.textContent =
      'Esc to cancel. The squares run from pure black on the left to a faint grey on the right.';

    const row = el('div', {
      display: 'flex',
      // Generous gutters: adjacent patches must not be judged against each
      // other, only against the black they sit on.
      gap: '18px',
      alignItems: 'center',
    });
    for (const code of CALIBRATION_LADDER) {
      const patch = el('button', {
        width: '64px',
        height: '64px',
        border: '0',
        padding: '0',
        margin: '0',
        borderRadius: '2px',
        background: `rgb(${code}, ${code}, ${code})`,
        cursor: 'pointer',
        // No focus ring and no hover state: either would be a bright pixel
        // arriving next to the patch being judged.
        outline: 'none',
      });
      patch.type = 'button';
      patch.setAttribute(
        'aria-label',
        code === 0 ? 'pure black' : `grey level ${code} of 255`,
      );
      patch.addEventListener('click', () => {
        if (code > 0) {
          conclude(code, false);
          return;
        }
        attempts += 1;
        if (attempts === 1) {
          // The control fired. Say plainly what it means and let them retry
          // once; a second identical answer is recorded rather than argued
          // with, flagged as suspect.
          footer.textContent =
            'That square is pure black — nothing at all is drawn there. Look again, and pick the leftmost square you can genuinely see.';
          return;
        }
        conclude(CALIBRATION_LADDER[1], true);
      });
      row.appendChild(patch);
    }
    stage.replaceChildren(row);
  };

  timers.push(window.setTimeout(showLadder, SETTLE_SECONDS * 1000));
  document.body.appendChild(root);
  return { close };
}
