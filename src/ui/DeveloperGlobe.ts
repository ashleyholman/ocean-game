import {
  globalTerrainSource,
  type GlobalTerrainSample,
  type GlobalTerrainSource,
} from '../terrain/GlobalTerrainSource';

const TWO_PI = Math.PI * 2;
const TERRAIN_PIXEL_STEP = 3;
const NOTICE_ANCHOR_TOLERANCE_RAD = 10 / 6_371_008.8;

export interface DeveloperGlobeSelection {
  latitudeRad: number;
  longitudeRad: number;
}

export interface DeveloperGlobeViewBasis {
  eastX: number;
  eastY: number;
  eastZ: number;
  northX: number;
  northY: number;
  northZ: number;
  forwardX: number;
  forwardY: number;
  forwardZ: number;
}

export interface DeveloperGlobeTerrainPixel {
  readonly selection: DeveloperGlobeSelection;
  readonly sample: GlobalTerrainSample;
  readonly fillStyle: string;
}

/**
 * Small orthographic globe shared by the player and developer world panels.
 * It is intentionally independent of Three.js: drag changes the view, while a
 * click unprojects the front hemisphere into a geodetic latitude/longitude
 * selection. Land and relief come from the same coarse provider as live local
 * terrain rather than from a second UI-only map.
 */
export class DeveloperGlobe {
  readonly element: HTMLDivElement;

  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly caption: HTMLDivElement;
  private centerLatitudeRad: number;
  private centerLongitudeRad: number;
  private markerLatitudeRad: number;
  private markerLongitudeRad: number;
  private pointerId: number | null = null;
  private pointerStartX = 0;
  private pointerStartY = 0;
  private lastPointerX = 0;
  private lastPointerY = 0;
  private dragged = false;
  private terrainPixels: Array<{
    x: number;
    y: number;
    fillStyle: string;
  }> = [];
  private selectionNotice: string | null = null;
  private selectionNoticeAnchor: DeveloperGlobeSelection | null = null;
  private terrainPixelsLatitudeRad = Number.NaN;
  private terrainPixelsLongitudeRad = Number.NaN;

  constructor(
    latitudeRad: number,
    longitudeRad: number,
    private readonly onSelect: (selection: DeveloperGlobeSelection) => void,
    private readonly terrainSource: GlobalTerrainSource = globalTerrainSource,
  ) {
    this.centerLatitudeRad = latitudeRad;
    this.centerLongitudeRad = longitudeRad;
    this.markerLatitudeRad = latitudeRad;
    this.markerLongitudeRad = longitudeRad;

    this.element = document.createElement('div');
    this.element.className = 'developer-globe';

    const heading = document.createElement('div');
    heading.className = 'globe-heading';
    heading.textContent = 'Location · drag / click to teleport';

    this.canvas = document.createElement('canvas');
    this.canvas.width = 600;
    this.canvas.height = 360;
    this.canvas.setAttribute(
      'aria-label',
      'Developer globe with coarse land relief. Drag to rotate and click to teleport.',
    );
    this.canvas.tabIndex = 0;
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('2D canvas is required for the developer globe');
    this.context = context;

    this.caption = document.createElement('div');
    this.caption.className = 'globe-caption';
    this.element.append(heading, this.canvas, this.caption);

    this.canvas.addEventListener('pointerdown', this.handlePointerDown);
    this.canvas.addEventListener('pointermove', this.handlePointerMove);
    this.canvas.addEventListener('pointerup', this.handlePointerUp);
    this.canvas.addEventListener('pointercancel', this.handlePointerCancel);
    this.draw();
  }

  update(latitudeRad: number, longitudeRad: number): void {
    const noticeBecameStale =
      this.selectionNoticeAnchor !== null &&
      angularSeparationRad(
        this.selectionNoticeAnchor.latitudeRad,
        this.selectionNoticeAnchor.longitudeRad,
        latitudeRad,
        longitudeRad,
      ) > NOTICE_ANCHOR_TOLERANCE_RAD;
    if (noticeBecameStale) {
      this.selectionNotice = null;
      this.selectionNoticeAnchor = null;
    }
    const changed =
      Math.abs(latitudeRad - this.markerLatitudeRad) > 1e-10 ||
      Math.abs(wrappedDifference(longitudeRad, this.markerLongitudeRad)) >
        1e-10;
    this.markerLatitudeRad = latitudeRad;
    this.markerLongitudeRad = longitudeRad;
    if (changed || noticeBecameStale) this.draw();
  }

  /** Publish the outcome of the last click without rebuilding terrain pixels. */
  setSelectionNotice(
    notice: string | null,
    anchor?: Readonly<DeveloperGlobeSelection>,
  ): void {
    const nextAnchor = notice
      ? {
          latitudeRad: anchor?.latitudeRad ?? this.markerLatitudeRad,
          longitudeRad: anchor?.longitudeRad ?? this.markerLongitudeRad,
        }
      : null;
    if (
      notice === this.selectionNotice &&
      nextAnchor?.latitudeRad === this.selectionNoticeAnchor?.latitudeRad &&
      nextAnchor?.longitudeRad === this.selectionNoticeAnchor?.longitudeRad
    ) {
      return;
    }
    this.selectionNotice = notice;
    this.selectionNoticeAnchor = nextAnchor;
    this.drawCaption();
  }

  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerup', this.handlePointerUp);
    this.canvas.removeEventListener('pointercancel', this.handlePointerCancel);
    this.element.remove();
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    this.pointerId = event.pointerId;
    this.pointerStartX = event.clientX;
    this.pointerStartY = event.clientY;
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;
    this.dragged = false;
    this.canvas.setPointerCapture(event.pointerId);
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (this.pointerId !== event.pointerId) return;
    const totalDistance = Math.hypot(
      event.clientX - this.pointerStartX,
      event.clientY - this.pointerStartY,
    );
    if (totalDistance > 3) this.dragged = true;
    if (!this.dragged) return;

    const rect = this.canvas.getBoundingClientRect();
    const scale = Math.PI / Math.max(80, Math.min(rect.width, rect.height));
    this.centerLongitudeRad = wrapLongitude(
      this.centerLongitudeRad -
        (event.clientX - this.lastPointerX) * scale,
    );
    this.centerLatitudeRad = clamp(
      this.centerLatitudeRad +
        (event.clientY - this.lastPointerY) * scale,
      -Math.PI / 2,
      Math.PI / 2,
    );
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;
    this.draw();
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (this.pointerId !== event.pointerId) return;
    if (!this.dragged) {
      const selection = this.unproject(event.clientX, event.clientY);
      if (selection) this.onSelect(selection);
    }
    this.canvas.releasePointerCapture(event.pointerId);
    this.pointerId = null;
  };

  private readonly handlePointerCancel = (event: PointerEvent): void => {
    if (this.pointerId !== event.pointerId) return;
    this.pointerId = null;
  };

  private unproject(
    clientX: number,
    clientY: number,
  ): DeveloperGlobeSelection | null {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * this.canvas.width;
    const y = ((clientY - rect.top) / rect.height) * this.canvas.height;
    const cx = this.canvas.width / 2;
    const cy = this.canvas.height / 2;
    const radius = Math.min(this.canvas.width, this.canvas.height) / 2 - 18;
    const projectedX = (x - cx) / radius;
    const projectedY = (cy - y) / radius;
    const radiusSquared =
      projectedX * projectedX + projectedY * projectedY;
    if (radiusSquared > 1) return null;
    const basis = this.viewBasis();
    return developerGlobeLocationAtProjectedPoint(
      basis,
      projectedX,
      projectedY,
    );
  }

  private draw(): void {
    const context = this.context;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.min(width, height) / 2 - 18;

    context.clearRect(0, 0, width, height);
    const gradient = context.createRadialGradient(
      cx - radius * 0.32,
      cy - radius * 0.38,
      radius * 0.08,
      cx,
      cy,
      radius,
    );
    gradient.addColorStop(0, '#416a84');
    gradient.addColorStop(0.66, '#18384e');
    gradient.addColorStop(1, '#081825');
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(cx, cy, radius, 0, TWO_PI);
    context.fill();

    context.save();
    context.beginPath();
    context.arc(cx, cy, radius, 0, TWO_PI);
    context.clip();
    this.drawTerrainSurface(context, cx, cy, radius);
    context.lineWidth = 1.4;

    for (let latitudeDeg = -60; latitudeDeg <= 60; latitudeDeg += 30) {
      this.drawCurve(
        context,
        Array.from({ length: 145 }, (_, index) => ({
          latitudeRad: (latitudeDeg * Math.PI) / 180,
          longitudeRad: -Math.PI + (index / 144) * TWO_PI,
        })),
        cx,
        cy,
        radius,
      );
    }
    for (let longitudeDeg = -150; longitudeDeg <= 180; longitudeDeg += 30) {
      this.drawCurve(
        context,
        Array.from({ length: 73 }, (_, index) => ({
          latitudeRad: -Math.PI / 2 + (index / 72) * Math.PI,
          longitudeRad: (longitudeDeg * Math.PI) / 180,
        })),
        cx,
        cy,
        radius,
      );
    }
    context.restore();

    context.strokeStyle = 'rgba(155, 207, 235, 0.64)';
    context.lineWidth = 2;
    context.beginPath();
    context.arc(cx, cy, radius, 0, TWO_PI);
    context.stroke();

    const marker = this.project(
      this.markerLatitudeRad,
      this.markerLongitudeRad,
    );
    if (marker.depth >= 0) {
      const markerX = cx + marker.x * radius;
      const markerY = cy - marker.y * radius;
      context.fillStyle = '#ffd27f';
      context.strokeStyle = 'rgba(9, 16, 24, 0.9)';
      context.lineWidth = 3;
      context.beginPath();
      context.arc(markerX, markerY, 7, 0, TWO_PI);
      context.fill();
      context.stroke();
    }

    this.drawCaption();
  }

  private drawCaption(): void {
    const markerSurface = this.terrainSource.sample(
      this.markerLatitudeRad,
      this.markerLongitudeRad,
    );
    this.caption.textContent =
      `${formatLatitude(this.markerLatitudeRad)} · ` +
      `${formatLongitude(this.markerLongitudeRad)} · ` +
      (markerSurface.surface === 'land'
        ? `coarse land ${markerSurface.heightM.toFixed(0)} m`
        : 'ocean') +
      (this.selectionNotice ? ` · ${this.selectionNotice}` : '');
  }

  private drawTerrainSurface(
    context: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    radius: number,
  ): void {
    if (
      this.centerLatitudeRad !== this.terrainPixelsLatitudeRad ||
      this.centerLongitudeRad !== this.terrainPixelsLongitudeRad
    ) {
      const basis = this.viewBasis();
      const minimumX = Math.floor(cx - radius);
      const maximumX = Math.ceil(cx + radius);
      const minimumY = Math.floor(cy - radius);
      const maximumY = Math.ceil(cy + radius);
      const terrainPixels: typeof this.terrainPixels = [];
      for (let y = minimumY; y < maximumY; y += TERRAIN_PIXEL_STEP) {
        const projectedY =
          (cy - (y + TERRAIN_PIXEL_STEP / 2)) / radius;
        for (let x = minimumX; x < maximumX; x += TERRAIN_PIXEL_STEP) {
          const projectedX =
            (x + TERRAIN_PIXEL_STEP / 2 - cx) / radius;
          const terrain = sampleDeveloperGlobeTerrain(
            this.terrainSource,
            basis,
            projectedX,
            projectedY,
          );
          if (!terrain || terrain.sample.surface !== 'land') continue;
          terrainPixels.push({ x, y, fillStyle: terrain.fillStyle });
        }
      }
      this.terrainPixels = terrainPixels;
      this.terrainPixelsLatitudeRad = this.centerLatitudeRad;
      this.terrainPixelsLongitudeRad = this.centerLongitudeRad;
    }
    for (const pixel of this.terrainPixels) {
      context.fillStyle = pixel.fillStyle;
      context.fillRect(
        pixel.x,
        pixel.y,
        TERRAIN_PIXEL_STEP + 0.5,
        TERRAIN_PIXEL_STEP + 0.5,
      );
    }
  }

  private drawCurve(
    context: CanvasRenderingContext2D,
    points: ReadonlyArray<DeveloperGlobeSelection>,
    cx: number,
    cy: number,
    radius: number,
  ): void {
    context.strokeStyle = 'rgba(174, 214, 232, 0.22)';
    let drawing = false;
    context.beginPath();
    for (const point of points) {
      const projected = this.project(
        point.latitudeRad,
        point.longitudeRad,
      );
      if (projected.depth < 0) {
        drawing = false;
        continue;
      }
      const x = cx + projected.x * radius;
      const y = cy - projected.y * radius;
      if (!drawing) {
        context.moveTo(x, y);
        drawing = true;
      } else {
        context.lineTo(x, y);
      }
    }
    context.stroke();
  }

  private project(
    latitudeRad: number,
    longitudeRad: number,
  ): { x: number; y: number; depth: number } {
    const cosLatitude = Math.cos(latitudeRad);
    const x = cosLatitude * Math.cos(longitudeRad);
    const y = cosLatitude * Math.sin(longitudeRad);
    const z = Math.sin(latitudeRad);
    const basis = this.viewBasis();
    return {
      x: x * basis.eastX + y * basis.eastY + z * basis.eastZ,
      y: x * basis.northX + y * basis.northY + z * basis.northZ,
      depth:
        x * basis.forwardX + y * basis.forwardY + z * basis.forwardZ,
    };
  }

  private viewBasis(): DeveloperGlobeViewBasis {
    return developerGlobeViewBasis(
      this.centerLatitudeRad,
      this.centerLongitudeRad,
    );
  }
}

export function developerGlobeViewBasis(
  centerLatitudeRad: number,
  centerLongitudeRad: number,
): DeveloperGlobeViewBasis {
  const sinLatitude = Math.sin(centerLatitudeRad);
  const cosLatitude = Math.cos(centerLatitudeRad);
  const sinLongitude = Math.sin(centerLongitudeRad);
  const cosLongitude = Math.cos(centerLongitudeRad);
  return {
    eastX: -sinLongitude,
    eastY: cosLongitude,
    eastZ: 0,
    northX: -sinLatitude * cosLongitude,
    northY: -sinLatitude * sinLongitude,
    northZ: cosLatitude,
    forwardX: cosLatitude * cosLongitude,
    forwardY: cosLatitude * sinLongitude,
    forwardZ: sinLatitude,
  };
}

export function developerGlobeLocationAtProjectedPoint(
  basis: Readonly<DeveloperGlobeViewBasis>,
  projectedX: number,
  projectedY: number,
): DeveloperGlobeSelection | null {
  const radiusSquared = projectedX * projectedX + projectedY * projectedY;
  if (radiusSquared > 1) return null;
  const depth = Math.sqrt(Math.max(0, 1 - radiusSquared));
  const sphereX =
    basis.eastX * projectedX +
    basis.northX * projectedY +
    basis.forwardX * depth;
  const sphereY =
    basis.eastY * projectedX +
    basis.northY * projectedY +
    basis.forwardY * depth;
  const sphereZ =
    basis.eastZ * projectedX +
    basis.northZ * projectedY +
    basis.forwardZ * depth;
  return {
    latitudeRad: Math.asin(clamp(sphereZ, -1, 1)),
    longitudeRad: wrapLongitude(Math.atan2(sphereY, sphereX)),
  };
}

export function sampleDeveloperGlobeTerrain(
  source: Pick<GlobalTerrainSource, 'sample'>,
  basis: Readonly<DeveloperGlobeViewBasis>,
  projectedX: number,
  projectedY: number,
): DeveloperGlobeTerrainPixel | null {
  const selection = developerGlobeLocationAtProjectedPoint(
    basis,
    projectedX,
    projectedY,
  );
  if (!selection) return null;
  const sample = source.sample(selection.latitudeRad, selection.longitudeRad);
  const depth = Math.sqrt(
    Math.max(0, 1 - projectedX * projectedX - projectedY * projectedY),
  );
  return {
    selection,
    sample,
    fillStyle: developerGlobeTerrainFillStyle(
      sample,
      projectedX,
      projectedY,
      depth,
    ),
  };
}

function developerGlobeTerrainFillStyle(
  sample: Readonly<GlobalTerrainSample>,
  projectedX: number,
  projectedY: number,
  depth: number,
): string {
  if (sample.surface === 'ocean') return 'rgba(0, 0, 0, 0)';
  const relief = clamp(sample.relief01, 0, 1);
  const light = clamp(
    0.58 - projectedX * 0.18 + projectedY * 0.28 + depth * 0.2,
    0.42,
    1,
  );
  const low = { r: 43, g: 91, b: 51 };
  const high = { r: 181, g: 169, b: 139 };
  const snow = { r: 224, g: 227, b: 218 };
  const mountain = smoothstep(0.08, 0.78, relief);
  const snowMix = smoothstep(0.72, 1, relief);
  const r = mix(mix(low.r, high.r, mountain), snow.r, snowMix) * light;
  const g = mix(mix(low.g, high.g, mountain), snow.g, snowMix) * light;
  const b = mix(mix(low.b, high.b, mountain), snow.b, snowMix) * light;
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
}

function formatLatitude(latitudeRad: number): string {
  const degrees = Math.abs(latitudeRad * (180 / Math.PI));
  return `${degrees.toFixed(5)}°${latitudeRad < 0 ? 'S' : 'N'}`;
}

function formatLongitude(longitudeRad: number): string {
  const degrees = Math.abs(longitudeRad * (180 / Math.PI));
  return `${degrees.toFixed(5)}°${longitudeRad < 0 ? 'W' : 'E'}`;
}

function wrapLongitude(longitudeRad: number): number {
  let wrapped = (longitudeRad + Math.PI) % TWO_PI;
  if (wrapped < 0) wrapped += TWO_PI;
  return wrapped - Math.PI;
}

function wrappedDifference(aRad: number, bRad: number): number {
  return wrapLongitude(aRad - bRad);
}

function angularSeparationRad(
  latitudeARad: number,
  longitudeARad: number,
  latitudeBRad: number,
  longitudeBRad: number,
): number {
  const halfLatitude = (latitudeBRad - latitudeARad) / 2;
  const halfLongitude = wrappedDifference(longitudeBRad, longitudeARad) / 2;
  const haversine =
    Math.sin(halfLatitude) ** 2 +
    Math.cos(latitudeARad) *
      Math.cos(latitudeBRad) *
      Math.sin(halfLongitude) ** 2;
  return 2 * Math.asin(Math.sqrt(clamp(haversine, 0, 1)));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function mix(a: number, b: number, amount: number): number {
  return a + (b - a) * amount;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const normalized = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return normalized * normalized * (3 - 2 * normalized);
}
