import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BrowserDiagnosticsBridge } from '../src/runtime/diagnostics/BrowserDiagnosticsBridge';

class FakeClassList {
  private readonly names = new Set<string>();
  add(name: string): void { this.names.add(name); }
  remove(name: string): void { this.names.delete(name); }
  contains(name: string): boolean { return this.names.has(name); }
}

class FakeElement {
  id = '';
  type = '';
  className = '';
  textContent = '';
  hidden = false;
  readonly dataset: Record<string, string> = {};
  removed = false;

  remove(): void { this.removed = true; }
}

class FakeDocument {
  readonly documentElement = { classList: new FakeClassList() };
  readonly elements: FakeElement[] = [];
  private readonly listeners = new Map<string, (event: KeyboardEvent) => void>();
  readonly head = { appendChild: (_element: FakeElement) => undefined };
  readonly body = {
    append: (...elements: FakeElement[]) => this.elements.push(...elements),
  };

  createElement(): FakeElement {
    return new FakeElement();
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.set(type, listener as (event: KeyboardEvent) => void);
  }

  removeEventListener(type: string): void {
    this.listeners.delete(type);
  }
}

class FakeCanvas {
  private readonly listeners = new Map<string, (event: PointerEvent) => void>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.set(type, listener as (event: PointerEvent) => void);
  }

  removeEventListener(type: string): void {
    this.listeners.delete(type);
  }

  getBoundingClientRect(): DOMRect {
    return { left: 10, top: 20, width: 800, height: 600 } as DOMRect;
  }

  down(clientX: number, clientY: number): { prevented: boolean; stopped: boolean } {
    const state = { prevented: false, stopped: false };
    this.listeners.get('pointerdown')?.({
      button: 0,
      clientX,
      clientY,
      preventDefault: () => { state.prevented = true; },
      stopImmediatePropagation: () => { state.stopped = true; },
    } as unknown as PointerEvent);
    return state;
  }
}

describe('the browser diagnostics bridge', () => {
  it('accumulates deliberately captured rays in world and vessel coordinates', () => {
    const document = new FakeDocument();
    const canvas = new FakeCanvas();
    const scene = new THREE.Scene();
    const vessel = new THREE.Group();
    vessel.position.set(7, 3, -4);
    scene.add(vessel);

    const target = new THREE.Mesh(
      new THREE.BoxGeometry(2, 2, 0.2),
      new THREE.MeshBasicMaterial({ name: 'test-material' }),
    );
    target.name = 'ship:test-panel';
    target.position.set(0, 0, -3);
    vessel.add(target);

    const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 100);
    camera.position.set(7, 3, -4);
    camera.lookAt(7, 3, -7);
    scene.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);

    const bridge = new BrowserDiagnosticsBridge({
      document: document as unknown as Document,
      canvas: canvas as unknown as HTMLCanvasElement,
      camera,
      scene,
      vessel,
      walker: { x: 0, z: 0, eyeY: () => 1.62 },
    });
    bridge.publish();
    bridge.arm();
    const event = canvas.down(410, 320);
    bridge.publish();

    const element = document.elements.find((candidate) =>
      candidate.id === 'drift-browser-diagnostics');
    if (!element) throw new Error('missing diagnostics element');
    const reading = JSON.parse(element.textContent);
    const recorded = reading.inspectionRay.recorded;

    expect(element.dataset.version).toBe('3');
    expect(event).toEqual({ prevented: true, stopped: true });
    expect(reading.inspectionRay.armed).toBe(false);
    expect(reading.inspectionRay.recordedRays).toEqual([recorded]);
    expect(recorded.canvas).toEqual([400, 300]);
    expect(recorded.worldOrigin).toEqual([7, 3, -4]);
    expect(recorded.vesselOrigin).toEqual([0, 0, 0]);
    expect(recorded.hit.object).toBe('ship:test-panel');
    expect(recorded.hit.material).toBe('test-material');
    expect(reading.walker).toEqual({ x: 0, y: 1.62, z: 0 });

    // Subsequent ship motion updates the live camera record, never the evidence.
    vessel.position.x = 9;
    bridge.publish();
    const afterMotion = JSON.parse(element.textContent);
    expect(afterMotion.inspectionRay.recorded).toEqual(recorded);
    expect(afterMotion.inspectionRay.recordedRays).toEqual([recorded]);

    // A later capture appends evidence instead of replacing the first ray.
    vessel.position.x = 7;
    bridge.publish();
    bridge.arm();
    canvas.down(470, 320);
    bridge.publish();
    const afterSecondCapture = JSON.parse(element.textContent);
    expect(afterSecondCapture.inspectionRay.recordedRays).toHaveLength(2);
    expect(afterSecondCapture.inspectionRay.recordedRays[0]).toEqual(recorded);
    expect(afterSecondCapture.inspectionRay.recorded).toEqual(
      afterSecondCapture.inspectionRay.recordedRays[1],
    );
    let markerCount = 0;
    vessel.traverse((object) => {
      if (object.name === 'diagnostic:inspection-ray-marker') markerCount++;
    });
    expect(markerCount).toBe(2);

    bridge.clear();
    bridge.publish();
    const afterClear = JSON.parse(element.textContent);
    expect(afterClear.inspectionRay.recorded).toBeNull();
    expect(afterClear.inspectionRay.recordedRays).toEqual([]);
    markerCount = 0;
    vessel.traverse((object) => {
      if (object.name === 'diagnostic:inspection-ray-marker') markerCount++;
    });
    expect(markerCount).toBe(0);

    bridge.dispose();
    expect(element.removed).toBe(true);
  });
});
