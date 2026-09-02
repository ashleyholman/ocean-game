export interface BrowserViewportHost {
  readonly innerWidth: number;
  readonly innerHeight: number;
  setTimeout(callback: () => void, delayMilliseconds: number): number;
  clearTimeout(handle: number): void;
}

export interface BrowserViewportRenderer {
  setSize(width: number, height: number, updateStyle: boolean): void;
}

export interface BrowserViewportCamera {
  setViewport(width: number, height: number): void;
}

export interface BrowserViewportReading {
  width: number;
  height: number;
}

/** Mobile resize events are coalesced for 90 ms, matching the shipping loop. */
export const VIEWPORT_RESIZE_DEBOUNCE_MS = 90;

/**
 * Owns browser viewport observation and the paired renderer/camera resize.
 *
 * Startup remains explicit: the composition root calls `resize()` once at the
 * same point it did before constructing the frame driver. The frame driver then
 * calls `poll()` before sampling time so missed host events cannot leave a stale
 * drawing buffer or camera aspect for the frame being presented.
 */
export class BrowserViewport {
  readonly reading: BrowserViewportReading = { width: 0, height: 0 };

  private resizeTimer: number | undefined;

  constructor(
    private readonly host: BrowserViewportHost,
    private readonly renderer: BrowserViewportRenderer,
    private readonly camera: BrowserViewportCamera,
    private readonly debounceMilliseconds = VIEWPORT_RESIZE_DEBOUNCE_MS,
  ) {}

  /** Stable callback suitable for direct EventTarget registration. */
  readonly resize = (): void => {
    const width = Math.max(1, this.host.innerWidth);
    const height = Math.max(1, this.host.innerHeight);
    if (width === this.reading.width && height === this.reading.height) return;

    this.reading.width = width;
    this.reading.height = height;
    this.renderer.setSize(width, height, false);
    this.camera.setViewport(width, height);
  };

  /** Stable debounced event callback for resize and orientation changes. */
  readonly scheduleResize = (): void => {
    if (this.resizeTimer !== undefined) {
      this.host.clearTimeout(this.resizeTimer);
    }
    this.resizeTimer = this.host.setTimeout(
      this.resize,
      this.debounceMilliseconds,
    );
  };

  /** Stable per-frame fallback for hosts that miss or delay resize events. */
  readonly poll = (): void => {
    if (
      this.host.innerWidth !== this.reading.width ||
      this.host.innerHeight !== this.reading.height
    ) {
      this.resize();
    }
  };
}
