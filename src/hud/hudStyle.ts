/**
 * The player-facing interface's one stylesheet.
 *
 * Deliberately not the developer panels' look. Those are instruments: dense
 * monospace, hairline rules, everything on screen at once, because the person
 * reading them is looking for a number they already have a name for. This is
 * for someone who has never seen the thing before and is holding a phone, so
 * it trades density for size: system type, one accent, controls big enough to
 * hit with a thumb, and a panel that becomes a bottom sheet rather than a
 * floating window when the screen is narrow.
 *
 * The palette is the ship's own — the brass of the compass card
 * (`SailingPanel`'s `#efb45f`) against the deep blue-grey the sea reads as at
 * dusk — so the interface sits on the picture instead of on top of it.
 */

export const HUD_ACCENT = '#e8b871';
export const HUD_GOOD = '#7fd0a0';
export const HUD_WARN = '#e8a54b';
export const HUD_INK = '#dce8f2';
export const HUD_MUTED = '#8ba3b8';

const HUD_STYLE = `
.hud-launch {
  position: fixed; left: 16px; bottom: 16px; z-index: 60;
  /* A tap on the label must not select the label. */
  user-select: none; -webkit-user-select: none;
  display: flex; align-items: center; gap: 9px;
  min-height: 40px; padding: 0 16px 0 13px; border-radius: 999px;
  background: rgba(9, 16, 24, 0.62); color: ${HUD_INK};
  border: 1px solid rgba(255, 255, 255, 0.16);
  font: 600 12px/1 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
  letter-spacing: 0.09em; text-transform: uppercase;
  cursor: pointer; backdrop-filter: blur(8px);
  -webkit-tap-highlight-color: transparent;
  transition: background 160ms ease, border-color 160ms ease, opacity 160ms ease;
}
.hud-launch:hover,
.hud-launch:focus-visible {
  background: rgba(16, 27, 39, 0.86); border-color: rgba(232, 184, 113, 0.38);
}
.hud-launch[hidden] { display: none; }
.hud-launch .hud-mark {
  width: 9px; height: 9px; border-radius: 50%;
  background: ${HUD_ACCENT}; box-shadow: 0 0 8px rgba(232, 184, 113, 0.75);
}

.hud-panel {
  position: fixed; left: 16px; bottom: 68px; z-index: 62;
  display: flex; flex-direction: column;
  /* Wide enough for the five tabs to stand in one row: they wrap gracefully
     if a translation lengthens them, but a single row is the intended shape. */
  width: min(400px, calc(100vw - 32px));
  /* A fixed height, not a fitted one. A panel that resizes under the pointer
     as tabs change is jumpy to use and hides the fact that the page behind it
     scrolls; the frame stays put and the content moves inside it. */
  /* Anchored to the viewport rather than to the content: the same height on
     every page, and never so tall that it reaches the view switcher in the
     opposite corner. */
  height: min(820px, calc(100vh - 132px));
  overflow: hidden; border-radius: 14px;
  background: rgba(9, 16, 24, 0.90); color: ${HUD_INK};
  border: 1px solid rgba(255, 255, 255, 0.13);
  font: 13px/1.5 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
  backdrop-filter: blur(14px);
  box-shadow: 0 14px 44px rgba(0, 0, 0, 0.5);
}
.hud-panel[hidden] { display: none; }

.hud-head {
  flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between;
  gap: 8px; padding: 12px 10px 10px 16px;
}
.hud-head h2 {
  margin: 0; user-select: none; -webkit-user-select: none; font-size: 11px; font-weight: 700;
  letter-spacing: 0.16em; text-transform: uppercase; color: ${HUD_MUTED};
}
.hud-head-actions { display: flex; align-items: center; gap: 6px; }
.hud-switch-ui {
  min-height: 28px; padding: 0 11px; border-radius: 999px;
  background: rgba(255, 255, 255, 0.05); color: ${HUD_MUTED};
  border: 1px solid rgba(255, 255, 255, 0.12); cursor: pointer;
  font: 600 11px/1 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
  letter-spacing: 0.08em; text-transform: uppercase;
  user-select: none; -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
}
.hud-switch-ui:hover, .hud-switch-ui:focus-visible {
  background: rgba(232, 184, 113, 0.16); color: #f6e3c6;
  border-color: rgba(232, 184, 113, 0.32);
}

.hud-close {
  display: grid; place-items: center; width: 34px; height: 34px; padding: 0;
  border: 1px solid transparent; border-radius: 9px;
  background: transparent; color: ${HUD_MUTED}; cursor: pointer;
  font: 400 21px/1 ui-sans-serif, system-ui, sans-serif;
  -webkit-tap-highlight-color: transparent;
}
.hud-close:hover,
.hud-close:focus-visible {
  background: rgba(255, 255, 255, 0.07); color: ${HUD_INK};
}

.hud-tabs {
  flex: 0 0 auto; display: flex; flex-wrap: wrap; gap: 5px;
  padding: 0 12px 11px;
}
.hud-tab {
  flex: 0 0 auto; user-select: none; -webkit-user-select: none; min-height: 34px; padding: 0 11px; border-radius: 999px;
  background: rgba(255, 255, 255, 0.05); color: ${HUD_MUTED};
  border: 1px solid transparent; cursor: pointer;
  font: 600 12px/1 inherit; letter-spacing: 0.05em;
  -webkit-tap-highlight-color: transparent;
  transition: background 140ms ease, color 140ms ease;
}
.hud-tab:hover, .hud-tab:focus-visible { color: ${HUD_INK}; }
.hud-tab[aria-selected='true'] {
  background: rgba(232, 184, 113, 0.16); color: #f6e3c6;
  border-color: rgba(232, 184, 113, 0.34);
}

.hud-body {
  flex: 1 1 auto; min-height: 0; overflow-y: auto;
  overscroll-behavior: contain; -webkit-overflow-scrolling: touch;
  padding: 2px 16px 18px;
}
.hud-body > .hud-page[hidden] { display: none; }
.hud-status { padding: 22px 0; color: ${HUD_MUTED}; font-size: 12px; }

/* --- controls ------------------------------------------------------------ */

.hud-field { display: block; margin: 12px 0 0; }
.hud-field:first-child { margin-top: 8px; }
.hud-row {
  display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
}
.hud-name {
  color: ${HUD_MUTED}; user-select: none; -webkit-user-select: none; font-size: 11px; font-weight: 600;
  letter-spacing: 0.09em; text-transform: uppercase;
}
.hud-value {
  color: ${HUD_INK}; font-variant-numeric: tabular-nums;
  font-size: 13px; font-weight: 600;
}
.hud-note { margin: 5px 0 0; color: ${HUD_MUTED}; font-size: 11.5px; }

.hud-field input[type='range'] {
  display: block; width: 100%; margin: 7px 0 0; height: 26px;
  accent-color: ${HUD_ACCENT}; background: transparent; cursor: pointer;
  touch-action: pan-y;
}

.hud-slider-markers {
  position: relative; height: 15px; margin: -3px 8px 0;
  color: ${HUD_MUTED}; font-size: 8.5px; line-height: 1;
  font-variant-numeric: tabular-nums;
  user-select: none; -webkit-user-select: none;
}
.hud-slider-markers span {
  position: absolute; top: 0; transform: translateX(-50%); white-space: nowrap;
}
.hud-slider-markers span::before {
  content: ''; display: block; width: 1px; height: 3px; margin: 0 auto 2px;
  background: rgba(184, 199, 212, 0.48);
}
.hud-slider-markers span:first-child { transform: none; }
.hud-slider-markers span:first-child::before { margin-left: 0; }
.hud-slider-markers span:last-child { transform: translateX(-100%); }
.hud-slider-markers span:last-child::before { margin-right: 0; }

.hud-seg {
  display: flex; gap: 4px; margin-top: 8px; padding: 3px; border-radius: 11px;
  background: rgba(255, 255, 255, 0.05);
}
.hud-seg button {
  flex: 1 1 0; user-select: none; -webkit-user-select: none; min-width: 0; min-height: 36px; padding: 0 8px;
  border: 0; border-radius: 9px; background: transparent; color: ${HUD_MUTED};
  font: 600 12.5px/1 inherit; cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition: background 140ms ease, color 140ms ease;
}
.hud-seg button[aria-pressed='true'] {
  background: rgba(232, 184, 113, 0.18); color: #f6e3c6;
}
/* An order being carried out: the fill is how far through the work the crew
   are, so pressing "reefed" shows the reef going in rather than claiming it
   is already in. The stripes move only while there is work left. */
.hud-seg button[data-busy] {
  color: #f6e3c6;
  background:
    linear-gradient(90deg,
      rgba(232, 184, 113, 0.30) var(--hud-progress, 0%),
      rgba(232, 184, 113, 0.06) var(--hud-progress, 0%)),
    repeating-linear-gradient(115deg,
      rgba(232, 184, 113, 0.13) 0 8px,
      rgba(232, 184, 113, 0) 8px 16px);
  background-size: 100% 100%, 32px 100%;
  animation: hud-working 900ms linear infinite;
}
@keyframes hud-working {
  from { background-position: 0 0, 0 0; }
  to { background-position: 0 0, 32px 0; }
}

.hud-buttons { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 11px; }
.hud-buttons button {
  flex: 1 1 auto; user-select: none; -webkit-user-select: none; min-height: 38px; padding: 0 12px; border-radius: 10px;
  background: rgba(255, 255, 255, 0.06); color: ${HUD_INK};
  border: 1px solid rgba(255, 255, 255, 0.12);
  font: 600 12.5px/1 inherit; cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.hud-buttons button:hover, .hud-buttons button:focus-visible {
  background: rgba(232, 184, 113, 0.16); border-color: rgba(232, 184, 113, 0.32);
}

.hud-switch {
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; margin: 12px 0 0; cursor: pointer;
}
.hud-switch input { position: absolute; opacity: 0; pointer-events: none; }
.hud-switch .hud-track {
  flex: 0 0 auto; width: 46px; height: 27px; border-radius: 999px;
  background: rgba(255, 255, 255, 0.11); position: relative;
  transition: background 160ms ease;
}
.hud-switch .hud-track::after {
  content: ''; position: absolute; top: 3px; left: 3px;
  width: 21px; height: 21px; border-radius: 50%; background: #b6c6d4;
  transition: transform 160ms ease, background 160ms ease;
}
.hud-switch input:checked + .hud-track { background: rgba(232, 184, 113, 0.42); }
.hud-switch input:checked + .hud-track::after {
  transform: translateX(19px); background: ${HUD_ACCENT};
}
.hud-switch input:focus-visible + .hud-track {
  outline: 2px solid rgba(232, 184, 113, 0.6); outline-offset: 2px;
}

.hud-select {
  display: block; width: 100%; margin-top: 8px; min-height: 40px;
  padding: 0 10px; border-radius: 10px;
  background: rgba(255, 255, 255, 0.06); color: ${HUD_INK};
  border: 1px solid rgba(255, 255, 255, 0.13);
  font: 600 13px/1 inherit; -webkit-appearance: none; appearance: none;
  cursor: pointer;
}
.hud-select option { background: #0d1620; color: ${HUD_INK}; }

.hud-canvas {
  /* Capped rather than fluid: the compass is an instrument, not a hero image,
     and letting it grow with the panel pushes the sail controls off the page
     it shares. */
  display: block; width: 100%; max-width: 264px; height: auto;
  margin: 8px auto 0; touch-action: none;
}

.hud-months {
  position: relative; height: 13px; margin-top: 2px;
  color: ${HUD_MUTED}; font-size: 9.5px; letter-spacing: 0.04em;
  user-select: none; -webkit-user-select: none;
}
.hud-months span { position: absolute; transform: translateX(-50%); }

.hud-section {
  margin: 17px 0 0; padding-top: 11px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  color: ${HUD_MUTED}; font-size: 10.5px; font-weight: 700;
  letter-spacing: 0.17em; text-transform: uppercase;
}

.hud-stat { display: flex; align-items: baseline; gap: 10px; margin-top: 10px; }
.hud-stat .hud-big {
  font: 700 30px/1 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-variant-numeric: tabular-nums; color: ${HUD_INK};
}
.hud-stat .hud-unit { color: ${HUD_MUTED}; font-size: 12px; letter-spacing: 0.08em; }

.hud-lines {
  margin: 12px 0 0; color: ${HUD_MUTED}; white-space: pre-wrap;
  font: 12px/1.7 ui-monospace, SFMono-Regular, Menlo, monospace;
  font-variant-numeric: tabular-nums;
}

.hud-globe { margin-top: 10px; }
.hud-globe canvas {
  display: block; width: 100%; height: auto; border-radius: 10px;
  background: rgba(255, 255, 255, 0.03); cursor: crosshair; touch-action: none;
}
.hud-globe .globe-heading { display: none; }
.hud-globe .globe-caption {
  margin-top: 6px; text-align: center; color: ${HUD_MUTED};
  font-size: 11.5px; font-variant-numeric: tabular-nums;
}

.hud-view {
  position: fixed; left: 16px; top: 16px; z-index: 60;
  display: flex; gap: 4px; padding: 3px; border-radius: 999px;
  background: rgba(9, 16, 24, 0.58); backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 255, 255, 0.14);
  user-select: none; -webkit-user-select: none;
}
.hud-view[hidden] { display: none; }
.hud-view button {
  min-height: 32px; padding: 0 14px; border: 0; border-radius: 999px;
  background: transparent; color: ${HUD_MUTED}; cursor: pointer;
  font: 600 12px/1 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
  letter-spacing: 0.06em;
  -webkit-tap-highlight-color: transparent;
  transition: background 140ms ease, color 140ms ease;
}
.hud-view button:hover, .hud-view button:focus-visible { color: ${HUD_INK}; }
.hud-view button[aria-pressed='true'] {
  background: rgba(232, 184, 113, 0.18); color: #f6e3c6;
}

/* The bottom sheet. Narrow screens get the full width and the bottom edge;
   the launcher would sit underneath it, so it stands down while open. */
@media (max-width: 620px) {
  .hud-panel {
    left: 0; right: 0; bottom: 0; width: 100%;
    height: min(74vh, calc(100vh - 44px));
    border-radius: 16px 16px 0 0;
    border-left: 0; border-right: 0; border-bottom: 0;
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }
  .hud-launch { left: 12px; bottom: calc(12px + env(safe-area-inset-bottom, 0px)); }
  .hud-view { left: 12px; top: calc(12px + env(safe-area-inset-top, 0px)); }
}
@media (max-height: 460px) {
  .hud-panel { height: calc(100vh - 24px); }
}
@media (prefers-reduced-motion: reduce) {
  .hud-launch, .hud-tab, .hud-seg button, .hud-view button,
  .hud-switch .hud-track,
  .hud-switch .hud-track::after { transition: none; }
  .hud-seg button[data-busy] { animation: none; }
}
`;

let installed = false;

/** Install the player-interface stylesheet exactly once. */
export function ensureHudStyle(): void {
  if (installed) return;
  installed = true;
  const style = document.createElement('style');
  style.textContent = HUD_STYLE;
  document.head.appendChild(style);
}
