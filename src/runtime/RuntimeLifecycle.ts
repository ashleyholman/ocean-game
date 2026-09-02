export type RuntimeCleanup = () => void;

/**
 * Owns EventTarget listener registrations and runtime teardown.
 *
 * Registered listeners are always detached before general cleanups run;
 * ordering must not depend on where assembly happened to register a listener.
 * Each group otherwise unwinds in reverse registration order. Disposal is
 * idempotent when multiple shutdown paths converge.
 */
export class RuntimeLifecycle {
  private readonly listenerCleanups: RuntimeCleanup[] = [];
  private readonly cleanups: RuntimeCleanup[] = [];
  private disposed = false;

  add(cleanup: RuntimeCleanup): void {
    if (this.disposed) {
      cleanup();
      return;
    }
    this.cleanups.push(cleanup);
  }

  listen(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void {
    target.addEventListener(type, listener, options);
    const cleanup = (): void =>
      target.removeEventListener(type, listener, options);
    if (this.disposed) {
      cleanup();
      return;
    }
    this.listenerCleanups.push(cleanup);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (let index = this.listenerCleanups.length - 1; index >= 0; index--) {
      this.listenerCleanups[index]();
    }
    this.listenerCleanups.length = 0;
    for (let index = this.cleanups.length - 1; index >= 0; index--) {
      this.cleanups[index]();
    }
    this.cleanups.length = 0;
  }
}
