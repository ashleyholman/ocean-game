/**
 * Evidence capture.
 *
 * Frames come from the real canvas after a real render, taken synchronously in
 * the same task so nothing depends on `requestAnimationFrame` pacing — a
 * background tab throttles rAF to about 1 Hz, which would otherwise make every
 * capture a test of the browser's scheduler rather than of the physics.
 *
 * Artefacts are POSTed to `tools/capture-server.mjs`.
 */
import type { SimCapability } from '../runtime/diagnostics/SimHandle';

export type LabCaptureCapability = SimCapability<
  'world' | 'refreshLighting' | 'lighting'
>;

/**
 * Capture-server port. Overridable with `?capturePort=` so a second worktree
 * can run its own evidence server without fighting over the default.
 */
const CAPTURE_PORT =
  Number(new URLSearchParams(window.location.search).get('capturePort') ?? 5199) || 5199;
const ENDPOINT = `http://127.0.0.1:${CAPTURE_PORT}/shot`;

export async function post(name: string, blob: Blob): Promise<boolean> {
  try {
    const response = await fetch(`${ENDPOINT}?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      body: blob,
      headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function toBlob(canvas: HTMLCanvasElement, type = 'image/jpeg', quality = 0.93): Promise<Blob> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b ?? new Blob()), type, quality));
}

export async function postText(name: string, text: string, type: string): Promise<boolean> {
  return post(name, new Blob([text], { type }));
}

/**
 * Copy the live drawing buffer. Must run in the same task as the render.
 *
 * "Must" is now enforced. Without `preserveDrawingBuffer` the browser is
 * entitled to have discarded the default framebuffer by the time any later
 * task looks, and Chrome exercises that entitlement: a copy taken from a
 * console evaluation, a CDP `Runtime.evaluate`, a `setTimeout` continuation or
 * anything after an `await` comes back all zeroes. It used to come back as a
 * black canvas that looked exactly like a capture, which is how several A/B
 * frames were silently lost in the ocean look round.
 *
 * An all-zero read is unambiguous rather than a heuristic: the renderer's
 * clear colour is 0x0a1420 and every pass writes over it, so a frame this
 * application actually drew cannot be pure black in all four channels. See
 * `debug/captureHost.ts` for the supported capture path.
 */
export function grab(canvas: HTMLCanvasElement, scale = 1): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = Math.round(canvas.width * scale);
  out.height = Math.round(canvas.height * scale);
  out.getContext('2d')!.drawImage(canvas, 0, 0, out.width, out.height);
  assertDrawingBufferWasReadable(out);
  return out;
}

/**
 * Fail loudly on a discarded drawing buffer instead of returning black.
 *
 * Samples a small thumbnail rather than the full frame: a discarded buffer is
 * uniformly zero, so 32x32 settles it, and a capture path should not pay a
 * full-resolution readback to find out it worked.
 */
export function assertDrawingBufferWasReadable(frame: HTMLCanvasElement): void {
  const probe = document.createElement('canvas');
  probe.width = Math.min(32, frame.width);
  probe.height = Math.min(32, frame.height);
  if (probe.width === 0 || probe.height === 0) return;
  const context = probe.getContext('2d', { willReadFrequently: true })!;
  context.drawImage(frame, 0, 0, probe.width, probe.height);
  const { data } = context.getImageData(0, 0, probe.width, probe.height);
  for (let index = 0; index < data.length; index += 4) {
    if (data[index] !== 0 || data[index + 1] !== 0 || data[index + 2] !== 0) {
      return;
    }
  }
  throw new Error(
    'captured frame is entirely black: the drawing buffer was discarded before ' +
      'it was read. Without preserveDrawingBuffer a copy is only valid in the ' +
      'same task as the render that filled it — a console/CDP evaluation, a ' +
      'setTimeout continuation or anything after an await is a new task. Use ' +
      '?capture=1 and window.__driftCapture.shot(), which renders and reads ' +
      'atomically. See docs/graphics/AGENT_INSPECTION.md.',
  );
}

/**
 * Walk the world clock to the instant closest to a target solar elevation, and
 * return the elevation actually reached.
 *
 * Elevation only. Azimuth is not a free variable — the sun's path is real
 * astronomy, so elevation and bearing are coupled through date and latitude and
 * asking for "40 degrees, abeam" frequently asks for an instant that does not
 * exist. Bearing is handled by moving the camera instead.
 *
 * Shared because three sheets had grown identical private copies, and a search
 * that decides which instant every piece of lighting evidence is taken at is
 * exactly the thing that must not quietly diverge between them.
 */
export function settleSunElevation(sim: LabCaptureCapability, targetElevationDeg: number): number {
  const state = sim.world.state;
  const base = state.worldInstantUtcSeconds;
  let best = base;
  let bestError = Infinity;
  let bestElevation = 0;

  for (let minute = 0; minute < 1440; minute += 2) {
    state.worldInstantUtcSeconds = base + minute * 60;
    sim.refreshLighting();
    const sun = sim.lighting.sunDirection;
    const elevationDeg = (Math.asin(Math.min(Math.max(sun.y, -1), 1)) * 180) / Math.PI;
    const error = Math.abs(elevationDeg - targetElevationDeg);
    if (error < bestError) {
      bestError = error;
      best = state.worldInstantUtcSeconds;
      bestElevation = elevationDeg;
    }
  }

  state.worldInstantUtcSeconds = best;
  sim.refreshLighting();
  return bestElevation;
}

export interface SheetFrame {
  image: HTMLCanvasElement;
  label: string;
}

/**
 * A time-coded contact sheet. Constant camera, fixed simulation increments,
 * timestamp under every frame — so a reviewer can look at an exact instant
 * rather than at an impression.
 */
export function buildContactSheet(
  frames: SheetFrame[],
  options: { columns?: number; title: string; subtitle?: string; cellWidth?: number },
): HTMLCanvasElement {
  const columns = options.columns ?? 6;
  const cellWidth = options.cellWidth ?? 400;
  const first = frames[0].image;
  const cellHeight = Math.round((cellWidth * first.height) / first.width);
  const labelHeight = 24;
  const rows = Math.ceil(frames.length / columns);
  const headerHeight = options.subtitle ? 62 : 40;
  const gap = 6;

  const canvas = document.createElement('canvas');
  canvas.width = columns * cellWidth + (columns + 1) * gap;
  canvas.height = headerHeight + rows * (cellHeight + labelHeight + gap) + gap;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#0b0f14';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#eaf1f8';
  ctx.font = '600 22px ui-monospace, SFMono-Regular, monospace';
  ctx.fillText(options.title, gap + 4, 28);
  if (options.subtitle) {
    ctx.fillStyle = '#8ea3ba';
    ctx.font = '14px ui-monospace, monospace';
    ctx.fillText(options.subtitle, gap + 4, 50);
  }

  frames.forEach((frame, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    const x = gap + col * (cellWidth + gap);
    const y = headerHeight + row * (cellHeight + labelHeight + gap);
    ctx.drawImage(frame.image, x, y, cellWidth, cellHeight);
    ctx.strokeStyle = '#1d2836';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, cellWidth - 1, cellHeight - 1);
    ctx.fillStyle = '#0f151c';
    ctx.fillRect(x, y + cellHeight, cellWidth, labelHeight);
    ctx.fillStyle = '#b9cade';
    ctx.font = '13px ui-monospace, monospace';
    ctx.fillText(frame.label, x + 6, y + cellHeight + 17);
  });

  return canvas;
}

/**
 * Record a WebM from the canvas while the caller steps the simulation.
 *
 * `captureStream(0)` gives a track that only produces a frame when explicitly
 * asked, which is what makes a deterministic, stepped capture possible.
 */
export class VideoRecorder {
  private recorder: MediaRecorder | undefined;
  private track: CanvasCaptureMediaStreamTrack | undefined;
  private chunks: Blob[] = [];

  constructor(private readonly canvas: HTMLCanvasElement) {}

  get supported(): boolean {
    return typeof MediaRecorder !== 'undefined' && typeof this.canvas.captureStream === 'function';
  }

  start(): boolean {
    if (!this.supported) return false;
    const stream = this.canvas.captureStream(0);
    this.track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(
      (m) => MediaRecorder.isTypeSupported(m),
    );
    if (!mime) return false;
    this.chunks = [];
    this.recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
    this.recorder.ondataavailable = (event) => {
      if (event.data.size) this.chunks.push(event.data);
    };
    this.recorder.start();
    return true;
  }

  /** Push the current drawing buffer as one video frame. */
  frame(): void {
    this.track?.requestFrame();
  }

  stop(): Promise<Blob> {
    return new Promise((resolve) => {
      const recorder = this.recorder;
      if (!recorder) return resolve(new Blob());
      recorder.onstop = () => resolve(new Blob(this.chunks, { type: 'video/webm' }));
      recorder.stop();
      this.track?.stop();
      this.recorder = undefined;
    });
  }
}

interface CanvasCaptureMediaStreamTrack extends MediaStreamTrack {
  requestFrame(): void;
}
