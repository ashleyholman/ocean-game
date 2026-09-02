/**
 * Four numbers, because four numbers is what a stranger's report can carry.
 *
 * The developer chip breaks the frame down into every CPU span and GPU pass it
 * can measure, which is the right instrument when the question is "which pass
 * got slower". The question here is different — "is it smooth on your
 * machine, and is it drawing at your screen's resolution while it does it" —
 * and the answer is a frame rate, a frame time, a buffer size and whether the
 * adaptive resolution walk has backed off.
 *
 * That last one earns its place: when the renderer drops below the panel's own
 * pixel grid everything downstream aliases harder, and from the outside that
 * reads as "it looked fine and then it went bad", with nothing on screen to
 * say why. So it is stated in words, in colour, rather than left as a ratio to
 * be worked out.
 */

import { HudGroup } from '../hudControls';
import { HUD_GOOD, HUD_MUTED, HUD_WARN } from '../hudStyle';
import type { HudPanel } from '../PlayerHud';
import type { RenderStatsReading } from '../../ui/RenderStats';

export interface PerfPanelSources {
  reading(): Readonly<RenderStatsReading>;
  /** Backing-store pixels per CSS pixel the display itself has. */
  nativePixelRatio(): number;
}

export function createPerfPanel(sources: PerfPanelSources): HudPanel {
  const group = new HudGroup();
  const fps = group.stat('frames per second');
  const lines = group.lines();

  const scaling = document.createElement('p');
  scaling.className = 'hud-note';
  group.element.appendChild(scaling);

  group.buttons([
    {
      label: 'Copy this report',
      title: 'Copy the numbers above, ready to paste back to whoever asked',
      onClick: () => {
        void navigator.clipboard?.writeText(report(sources));
      },
    },
  ]);

  // Start "overdue" so the first rendered frame fills the page in. Starting
  // at zero leaves a visibly empty panel for the first quarter-second, which
  // reads as a page that failed to load rather than one about to update.
  let accumulated = Number.POSITIVE_INFINITY;

  return {
    element: group.element,
    update(dtSeconds: number): void {
      accumulated += dtSeconds;
      if (accumulated < 0.25) return;
      accumulated = 0;

      const reading = sources.reading();
      fps.textContent =
        reading.fps === undefined ? '—' : reading.fps.toFixed(0);
      lines.textContent = [
        `frame time   ${
          reading.frameMs === undefined ? '—' : `${reading.frameMs.toFixed(1)} ms`
        }`,
        `resolution   ${reading.bufferWidth} × ${reading.bufferHeight}`,
        `render scale ${reading.renderScale.toFixed(2)}× of ${sources
          .nativePixelRatio()
          .toFixed(2)}× native`,
      ].join('\n');

      const reduced = isReduced(reading);
      scaling.textContent = reduced
        ? `Drawing below your screen's resolution — the renderer has backed off to keep up, which softens the picture.`
        : `Drawing at your screen's own resolution.`;
      scaling.style.color = reduced ? HUD_WARN : HUD_GOOD;
      if (!reading.profilingReady) {
        scaling.style.color = HUD_MUTED;
        scaling.textContent = 'Still settling — give it a few seconds.';
      }
    },
    dispose(): void {
      group.element.remove();
    },
  };
}

/**
 * Below native by more than rounding.
 *
 * `renderScale` is backing-store pixels per CSS pixel; `nativeScale` is what
 * the panel actually has. The tolerance is there because a device pixel ratio
 * is often not a round number and an exact comparison would call a 1:1 image
 * reduced.
 */
function isReduced(reading: Readonly<RenderStatsReading>): boolean {
  return reading.renderScale < reading.nativeScale - 0.01;
}

function report(sources: PerfPanelSources): string {
  const reading = sources.reading();
  return [
    'Drift performance report',
    `fps          ${reading.fps === undefined ? '—' : reading.fps.toFixed(0)}`,
    `frame time   ${
      reading.frameMs === undefined ? '—' : `${reading.frameMs.toFixed(1)} ms`
    }`,
    `resolution   ${reading.bufferWidth} × ${reading.bufferHeight}`,
    `render scale ${reading.renderScale.toFixed(2)}× of ${sources
      .nativePixelRatio()
      .toFixed(2)}× native${isReduced(reading) ? ' (reduced)' : ''}`,
    `window       ${window.innerWidth} × ${window.innerHeight} css px`,
    `agent        ${navigator.userAgent}`,
  ].join('\n');
}
