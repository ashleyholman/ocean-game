import * as THREE from 'three';

import type {
  InspectionRayHit,
  InspectionRayRecorder,
  RecordedInspectionRay,
} from './InspectionRayRecorder';

const DIAGNOSTICS_ELEMENT_ID = 'drift-browser-diagnostics';
const INSPECTION_ARMED_CLASS = 'drift-inspection-ray-armed';

export interface BrowserDiagnosticsWalker {
  readonly x: number;
  readonly z: number;
  eyeY(): number;
}

export interface BrowserDiagnosticsBridgeOptions {
  readonly document: Document;
  readonly canvas: HTMLCanvasElement;
  readonly camera: THREE.PerspectiveCamera;
  readonly scene: THREE.Scene;
  readonly vessel: THREE.Object3D;
  readonly walker?: BrowserDiagnosticsWalker;
}

/**
 * A development-only bridge between the live scene and browser diagnostics.
 *
 * Browser automation may execute in a JavaScript world that cannot see page
 * `window` expandos, while DOM state is shared. The bridge therefore publishes
 * the presented camera and a deliberately recorded inspection ray to inert JSON
 * in `#drift-browser-diagnostics`.
 *
 * Recorded rays are immutable. Each captures both world and vessel coordinates
 * at the click, so vessel motion after capture cannot move the evidence beneath
 * the investigator. Captures accumulate until explicitly cleared and each one
 * intercepts that pointer event before the game can interpret it as a look or
 * walk command.
 */
export class BrowserDiagnosticsBridge implements InspectionRayRecorder {
  private readonly element: HTMLScriptElement;
  private readonly style: HTMLStyleElement;
  private readonly banner: HTMLDivElement;
  private readonly vesselInverse = new THREE.Matrix4();
  private readonly cameraInVessel = new THREE.Matrix4();
  private readonly vesselCameraPosition = new THREE.Vector3();
  private readonly vesselCameraQuaternion = new THREE.Quaternion();
  private readonly vesselCameraScale = new THREE.Vector3();
  private readonly vesselPoint = new THREE.Vector3();
  private readonly vesselRayOrigin = new THREE.Vector3();
  private readonly vesselRayDirection = new THREE.Vector3();
  private readonly normalMatrix = new THREE.Matrix3();
  private readonly worldNormal = new THREE.Vector3();
  private readonly rayNdc = new THREE.Vector2();
  private readonly raycaster = new THREE.Raycaster();
  private readonly listeners = new Set<() => void>();

  private isArmed = false;
  private readonly rays: RecordedInspectionRay[] = [];
  private readonly markers: THREE.Group[] = [];
  private frame = 0;

  constructor(private readonly options: BrowserDiagnosticsBridgeOptions) {
    this.element = options.document.createElement('script');
    this.element.id = DIAGNOSTICS_ELEMENT_ID;
    this.element.type = 'application/json';
    this.element.dataset.version = '3';

    this.style = options.document.createElement('style');
    this.style.textContent = `
      html.${INSPECTION_ARMED_CLASS} .devtools-window,
      html.${INSPECTION_ARMED_CLASS} .devtools-launch { display: none !important; }
      html.${INSPECTION_ARMED_CLASS} canvas { cursor: crosshair !important; }
      .drift-inspection-ray-banner {
        position: fixed; left: 50%; top: 14px; z-index: 1000;
        transform: translateX(-50%); padding: 8px 12px; border-radius: 6px;
        background: rgba(9, 16, 25, 0.94); color: #dcecf8;
        border: 1px solid rgba(131, 192, 237, 0.45);
        font: 600 11px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
        pointer-events: none;
      }
      .drift-inspection-ray-banner[hidden] { display: none; }
    `;

    this.banner = options.document.createElement('div');
    this.banner.className = 'drift-inspection-ray-banner';
    this.banner.textContent = 'Click the scene to add an inspection ray · Esc cancels';
    this.banner.hidden = true;

    options.document.head.appendChild(this.style);
    options.document.body.append(this.element, this.banner);
    options.canvas.addEventListener('pointerdown', this.onPointerDown, true);
    options.document.addEventListener('keydown', this.onKeyDown, true);
  }

  get armed(): boolean {
    return this.isArmed;
  }

  get recordedRays(): readonly RecordedInspectionRay[] {
    return this.rays;
  }

  get recordedRay(): RecordedInspectionRay | null {
    return this.rays[this.rays.length - 1] ?? null;
  }

  arm(): void {
    if (this.isArmed) return;
    this.isArmed = true;
    this.options.document.documentElement.classList.add(INSPECTION_ARMED_CLASS);
    this.banner.hidden = false;
    this.notify();
  }

  cancel(): void {
    if (!this.isArmed) return;
    this.finishCaptureMode();
    this.notify();
  }

  clear(): void {
    this.rays.length = 0;
    this.clearMarkers();
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Publish the camera that was just presented by the renderer. */
  publish(): void {
    const { camera, canvas, vessel, walker } = this.options;
    this.updateSceneMatrices();

    const rect = canvas.getBoundingClientRect();
    this.element.textContent = JSON.stringify({
      version: 3,
      frame: ++this.frame,
      viewport: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      },
      camera: {
        fovDegrees: camera.fov,
        aspect: camera.aspect,
        near: camera.near,
        far: camera.far,
        worldPosition: camera.position.toArray(),
        worldQuaternion: camera.quaternion.toArray(),
        worldMatrix: camera.matrixWorld.toArray(),
        projectionMatrix: camera.projectionMatrix.toArray(),
        inverseProjectionMatrix: camera.projectionMatrixInverse.toArray(),
        vesselPosition: this.vesselCameraPosition.toArray(),
        vesselQuaternion: this.vesselCameraQuaternion.toArray(),
        vesselMatrix: this.cameraInVessel.toArray(),
      },
      vesselWorldMatrix: vessel.matrixWorld.toArray(),
      walker: walker
        ? { x: walker.x, y: walker.eyeY(), z: walker.z }
        : null,
      inspectionRay: {
        armed: this.isArmed,
        // Keep the latest record at the original path for older diagnostics
        // readers while publishing the complete ordered capture set beside it.
        recorded: this.recordedRay,
        recordedRays: this.rays,
      },
    });
  }

  dispose(): void {
    this.cancel();
    this.clearMarkers();
    this.options.canvas.removeEventListener('pointerdown', this.onPointerDown, true);
    this.options.document.removeEventListener('keydown', this.onKeyDown, true);
    this.listeners.clear();
    this.banner.remove();
    this.style.remove();
    this.element.remove();
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.isArmed || event.button !== 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.record(event.clientX, event.clientY);
    this.finishCaptureMode();
    this.notify();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.isArmed || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.cancel();
  };

  private finishCaptureMode(): void {
    this.isArmed = false;
    this.options.document.documentElement.classList.remove(INSPECTION_ARMED_CLASS);
    this.banner.hidden = true;
  }

  private record(clientX: number, clientY: number): void {
    const { camera, canvas, scene } = this.options;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    this.updateSceneMatrices();
    const cssX = clientX - rect.left;
    const cssY = clientY - rect.top;
    this.rayNdc.set(
      (cssX / rect.width) * 2 - 1,
      1 - (cssY / rect.height) * 2,
    );
    this.raycaster.setFromCamera(this.rayNdc, camera);

    const intersection = this.raycaster
      .intersectObjects(scene.children, true)
      .find((candidate) => !isInspectionHelper(candidate.object));
    const hit = intersection ? this.describeHit(intersection) : null;

    this.vesselRayOrigin
      .copy(this.raycaster.ray.origin)
      .applyMatrix4(this.vesselInverse);
    this.vesselRayDirection
      .copy(this.raycaster.ray.direction)
      .transformDirection(this.vesselInverse);

    const ray: RecordedInspectionRay = {
      frame: this.frame,
      client: [clientX, clientY],
      canvas: [cssX, cssY],
      ndc: [this.rayNdc.x, this.rayNdc.y],
      worldOrigin: this.raycaster.ray.origin.toArray(),
      worldDirection: this.raycaster.ray.direction.toArray(),
      vesselOrigin: this.vesselRayOrigin.toArray(),
      vesselDirection: this.vesselRayDirection.toArray(),
      hit,
    };

    this.rays.push(ray);
    if (intersection) this.showMarker(intersection);
  }

  private describeHit(hit: THREE.Intersection): InspectionRayHit {
    this.vesselPoint.copy(hit.point).applyMatrix4(this.vesselInverse);
    const faceNormal = hit.face?.normal;
    const normal = faceNormal
      ? this.worldNormal
        .copy(faceNormal)
        .applyMatrix3(this.normalMatrix.getNormalMatrix(hit.object.matrixWorld))
        .normalize()
        .toArray()
      : null;
    return {
      object: objectLabel(hit.object),
      type: hit.object.type,
      material: materialLabel(hit.object),
      distance: hit.distance,
      faceIndex: hit.faceIndex ?? null,
      worldPoint: hit.point.toArray(),
      vesselPoint: this.vesselPoint.toArray(),
      worldNormal: normal,
    };
  }

  private updateSceneMatrices(): void {
    const { camera, vessel } = this.options;
    camera.updateMatrixWorld(true);
    vessel.updateMatrixWorld(true);
    this.vesselInverse.copy(vessel.matrixWorld).invert();
    this.cameraInVessel.multiplyMatrices(this.vesselInverse, camera.matrixWorld);
    this.cameraInVessel.decompose(
      this.vesselCameraPosition,
      this.vesselCameraQuaternion,
      this.vesselCameraScale,
    );
  }

  private showMarker(hit: THREE.Intersection): void {
    const marker = new THREE.Group();
    marker.name = 'diagnostic:inspection-ray-marker';
    marker.userData.inspectionRayHelper = true;

    const size = 0.07;
    const geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-size, 0, 0), new THREE.Vector3(size, 0, 0),
      new THREE.Vector3(0, -size, 0), new THREE.Vector3(0, size, 0),
      new THREE.Vector3(0, 0, -size), new THREE.Vector3(0, 0, size),
    ]);
    const material = new THREE.LineBasicMaterial({
      color: 0xffd45a,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    const cross = new THREE.LineSegments(geometry, material);
    cross.userData.inspectionRayHelper = true;
    cross.renderOrder = 10_000;
    marker.add(cross);

    if (isDescendantOf(hit.object, this.options.vessel)) {
      marker.position.copy(this.vesselPoint);
      this.options.vessel.add(marker);
    } else {
      marker.position.copy(hit.point);
      this.options.scene.add(marker);
    }
    this.markers.push(marker);
  }

  private clearMarkers(): void {
    for (const marker of this.markers) {
      marker.removeFromParent();
      marker.traverse((object) => {
        if (!(object instanceof THREE.LineSegments)) return;
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) material.dispose();
      });
    }
    this.markers.length = 0;
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

function isDescendantOf(object: THREE.Object3D, ancestor: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function isInspectionHelper(object: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (current.userData.inspectionRayHelper === true) return true;
    current = current.parent;
  }
  return false;
}

function objectLabel(object: THREE.Object3D): string {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (current.name) return current.name;
    current = current.parent;
  }
  return object.type;
}

function materialLabel(object: THREE.Object3D): string | null {
  if (!(object instanceof THREE.Mesh)) return null;
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  return materials.map((material) => material.name || material.type).join(', ');
}
