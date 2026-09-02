import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  globalTerrainSource,
  type GlobalTerrainSource,
} from '../src/terrain/GlobalTerrainSource';
import {
  DeveloperGlobe,
  developerGlobeViewBasis,
  sampleDeveloperGlobeTerrain,
} from '../src/ui/DeveloperGlobe';

const DEG = Math.PI / 180;

describe('developer globe shared terrain rendering', () => {
  it('samples the provider at the orthographic centre', () => {
    const latitudeRad = -33.8688 * DEG;
    const longitudeRad = 151.2093 * DEG;
    const pixel = sampleDeveloperGlobeTerrain(
      globalTerrainSource,
      developerGlobeViewBasis(latitudeRad, longitudeRad),
      0,
      0,
    );
    expect(pixel).not.toBeNull();
    expect(pixel!.selection.latitudeRad).toBeCloseTo(latitudeRad, 12);
    expect(pixel!.selection.longitudeRad).toBeCloseTo(longitudeRad, 12);
    const direct = globalTerrainSource.sample(latitudeRad, longitudeRad);
    expect(pixel!.sample.surface).toBe(direct.surface);
    expect(pixel!.sample.heightM).toBeCloseTo(direct.heightM, 9);
    expect(pixel!.sample.relief01).toBeCloseTo(direct.relief01, 9);
    expect(pixel!.sample.surface).toBe('land');
    expect(pixel!.fillStyle).toMatch(/^rgb\(/);
  });

  it('keeps ocean transparent and makes high relief visually distinct', () => {
    const ocean = sampleDeveloperGlobeTerrain(
      globalTerrainSource,
      developerGlobeViewBasis(0, -140 * DEG),
      0,
      0,
    );
    const lowLand = sampleDeveloperGlobeTerrain(
      globalTerrainSource,
      developerGlobeViewBasis(-30 * DEG, 125 * DEG),
      0,
      0,
    );
    const everest = sampleDeveloperGlobeTerrain(
      globalTerrainSource,
      developerGlobeViewBasis(27.9805 * DEG, 86.8806 * DEG),
      0,
      0,
    );
    expect(ocean!.sample.surface).toBe('ocean');
    expect(ocean!.fillStyle).toBe('rgba(0, 0, 0, 0)');
    expect(lowLand!.sample.surface).toBe('land');
    expect(everest!.sample.relief01).toBeGreaterThan(lowLand!.sample.relief01);
    expect(everest!.fillStyle).not.toBe(lowLand!.fillStyle);
    expect(
      sampleDeveloperGlobeTerrain(
        globalTerrainSource,
        developerGlobeViewBasis(0, 0),
        1.01,
        0,
      ),
    ).toBeNull();
  });

  it('constructs and renders with finite coordinates before any update', () => {
    const context = createFakeContext();
    const document = createFakeDocument(context);
    vi.stubGlobal('document', document);

    const sample = vi.fn((latitudeRad: number, longitudeRad: number) => {
      if (!Number.isFinite(latitudeRad) || !Number.isFinite(longitudeRad)) {
        throw new Error('globe rendered a non-finite terrain coordinate');
      }
      return {
        latitudeRad,
        longitudeRad,
        surface: 'ocean' as const,
        heightM: -80,
        relief01: 0,
      };
    });
    const source: GlobalTerrainSource = {
      sourceBuildId: 'constructor-regression',
      manifest: globalTerrainSource.manifest,
      sample,
      nearestLandM: () => 1_000_000,
      locationKey: () => 'unused',
      tilesAt: () => [],
    };

    const globe = new DeveloperGlobe(-33.8688 * DEG, 151.2093 * DEG, () => {}, source);
    expect(sample).toHaveBeenCalled();
    expect(context.clearRect).toHaveBeenCalledTimes(1);
    expect(context.arc).toHaveBeenCalled();
    expect(context.stroke).toHaveBeenCalled();
    const constructionSamples = sample.mock.calls.length;
    globe.update(-33.8702 * DEG, 151.2087 * DEG);
    // Marker movement redraws the cached globe, not thousands of land queries.
    expect(sample.mock.calls.length - constructionSamples).toBe(1);

    const noticeLatitudeRad = -33.8702 * DEG;
    const noticeLongitudeRad = 151.2087 * DEG;
    globe.setSelectionNotice('moved 24.5 km to qualified coarse water', {
      latitudeRad: noticeLatitudeRad,
      longitudeRad: noticeLongitudeRad,
    });
    const caption = globe.element.children[2] as HTMLElement;
    expect(caption.textContent).toContain(
      'moved 24.5 km to qualified coarse water',
    );
    // Caption-only feedback samples the marker once but does not rebuild the
    // cached 3 px terrain surface.
    expect(sample.mock.calls.length - constructionSamples).toBe(2);

    globe.update(
      noticeLatitudeRad + 5 / 6_371_008.8,
      noticeLongitudeRad,
    );
    expect(caption.textContent).toContain('qualified coarse water');
    globe.update(
      noticeLatitudeRad + 20 / 6_371_008.8,
      noticeLongitudeRad,
    );
    expect(caption.textContent).not.toContain('qualified coarse water');
    globe.dispose();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function createFakeContext(): CanvasRenderingContext2D & {
  clearRect: ReturnType<typeof vi.fn>;
  arc: ReturnType<typeof vi.fn>;
  stroke: ReturnType<typeof vi.fn>;
} {
  const gradient = { addColorStop: vi.fn() };
  return {
    clearRect: vi.fn(),
    createRadialGradient: vi.fn(() => gradient),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    save: vi.fn(),
    clip: vi.fn(),
    fillRect: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    restore: vi.fn(),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
  } as unknown as CanvasRenderingContext2D & {
    clearRect: ReturnType<typeof vi.fn>;
    arc: ReturnType<typeof vi.fn>;
    stroke: ReturnType<typeof vi.fn>;
  };
}

function createFakeDocument(context: CanvasRenderingContext2D): Document {
  class FakeElement {
    className = '';
    textContent: string | null = null;
    readonly children: unknown[] = [];

    append(...children: unknown[]): void {
      this.children.push(...children);
    }

    remove(): void {}
  }

  class FakeCanvas extends FakeElement {
    width = 300;
    height = 150;
    tabIndex = -1;

    setAttribute(): void {}
    getContext(kind: string): CanvasRenderingContext2D | null {
      return kind === '2d' ? context : null;
    }
    addEventListener(): void {}
    removeEventListener(): void {}
    setPointerCapture(): void {}
    releasePointerCapture(): void {}
  }

  return {
    createElement: (tagName: string) =>
      tagName === 'canvas' ? new FakeCanvas() : new FakeElement(),
  } as unknown as Document;
}
