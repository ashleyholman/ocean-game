import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CameraMode } from '../src/camera/CameraSystem';
import {
  captureCameraDescriptionParts,
  readCaptureCameraMetadata,
  resolveCaptureCameraSpec,
  stageCaptureCamera,
} from '../src/debug/captureSceneCamera';

const BASE_SCENE = { lookPitchDeg: 0 } as const;

describe('capture host camera dimension', () => {
  it.each([
    ['omitted', undefined],
    ['explicit', 'embodied' as const],
  ])('preserves the %s embodied staging path', (_name, cameraMode) => {
    const fixture = createCameraFixture();
    const scene = { ...BASE_SCENE, cameraMode };

    expect(
      stageCaptureCamera(fixture.cameras, scene, 140, fixture.publishPose),
    ).toEqual({ mode: 'embodied', cinematicScale: null });
    expect(fixture.calls).toEqual(['mode:embodied', 'look']);
    expect(fixture.look).toEqual({
      yaw: Math.PI - (140 * Math.PI) / 180,
      pitch: 0,
    });
    expect(readCaptureCameraMetadata(fixture.cameras)).toEqual({
      cameraMode: 'embodied',
      cinematicScale: null,
    });
  });

  it('resets and adopts the existing cinematic controller deterministically', () => {
    const fixture = createCameraFixture();
    const scene = { ...BASE_SCENE, cameraMode: 'cinematic' as const };

    const first = stageCaptureCamera(
      fixture.cameras,
      scene,
      25,
      fixture.publishPose,
    );
    expect(first).toEqual({ mode: 'cinematic', cinematicScale: null });
    expect(fixture.calls).toEqual([
      'mode:embodied',
      'look',
      'publish-pose',
      'reset-cinematic',
      'mode:cinematic',
    ]);
    expect(readCaptureCameraMetadata(fixture.cameras)).toEqual({
      cameraMode: 'cinematic',
      cinematicScale: 0.4,
    });

    fixture.calls.length = 0;
    const second = stageCaptureCamera(
      fixture.cameras,
      scene,
      25,
      fixture.publishPose,
    );
    expect(second).toEqual(first);
    expect(readCaptureCameraMetadata(fixture.cameras)).toEqual({
      cameraMode: 'cinematic',
      cinematicScale: 0.4,
    });
  });

  it('stages the named maximum-cinematic-over-far-ocean pairing in this host', () => {
    const fixture = createCameraFixture();
    const scene = {
      ...BASE_SCENE,
      cameraMode: 'cinematic' as const,
      cinematicScale: 1,
      lookBearingDeg: 312,
    };

    expect(
      stageCaptureCamera(fixture.cameras, scene, 20, fixture.publishPose),
    ).toEqual({ mode: 'cinematic', cinematicScale: 1 });
    expect(fixture.calls).toContain('scale:1');
    expect(readCaptureCameraMetadata(fixture.cameras)).toEqual({
      cameraMode: 'cinematic',
      cinematicScale: 1,
    });

    const host = readFileSync('src/debug/captureHost.ts', 'utf8');
    const cli = readFileSync('tools/ab-sheet.mjs', 'utf8');
    const defaultScene = host.match(
      /export const DEFAULT_SCENE:[\s\S]*?\n};/,
    )?.[0];
    expect(defaultScene).toBeDefined();
    expect(defaultScene).not.toContain('cameraMode');
    expect(defaultScene).not.toContain('cinematicScale');
    expect(host).toMatch(/placeEye\(scene\.stand\);[\s\S]*stageCaptureCamera\(/);
    expect(host).toContain('...captureCameraDescriptionParts(scene)');
    expect(host).not.toContain('new THREE.PerspectiveCamera');
    expect(cli).toContain("'cinematicScale'");
    expect(cli).toContain('cameraMode: shot.cameraMode');
    expect(cli).toContain('cinematicScale: shot.cinematicScale');
  });

  it('publishes stable browser-free camera captions and actual metadata', () => {
    const fixture = createCameraFixture();
    stageCaptureCamera(
      fixture.cameras,
      {
        ...BASE_SCENE,
        cameraMode: 'cinematic',
        cinematicScale: 1,
      },
      0,
      fixture.publishPose,
    );
    const first = readCaptureCameraMetadata(fixture.cameras);
    const second = readCaptureCameraMetadata(fixture.cameras);
    expect(first).toEqual(second);
    expect(captureCameraDescriptionParts(BASE_SCENE)).toEqual([]);
    expect(
      captureCameraDescriptionParts({
        ...BASE_SCENE,
        cameraMode: 'cinematic',
        cinematicScale: 1,
      }),
    ).toEqual(['camera cinematic', 'cinematic scale 1.00']);
  });

  it('rejects unknown modes, invalid scales, and unsupported cinematic pitch', () => {
    expect(() =>
      resolveCaptureCameraSpec({ cameraMode: 'orbit' as CameraMode }),
    ).toThrow(/cameraMode/);
    expect(() => resolveCaptureCameraSpec({ cinematicScale: 1 })).toThrow(
      /requires cameraMode cinematic/,
    );
    for (const cinematicScale of [-0.01, 1.01, Number.NaN]) {
      expect(() =>
        resolveCaptureCameraSpec({
          cameraMode: 'cinematic',
          cinematicScale,
        }),
      ).toThrow(/cinematicScale/);
    }
    expect(() =>
      resolveCaptureCameraSpec({
        cameraMode: 'cinematic',
        lookPitchDeg: 1,
      }),
    ).toThrow(/lookPitchDeg/);
  });
});

function createCameraFixture() {
  const calls: string[] = [];
  let modeName: CameraMode = 'cinematic';
  let cinematicScale = 0.75;
  let look = { yaw: 0, pitch: 0 };
  const cameras = {
    get modeName(): CameraMode {
      return modeName;
    },
    get cinematicScale(): number {
      return cinematicScale;
    },
    get look() {
      return look;
    },
    set look(value: { yaw: number; pitch: number }) {
      calls.push('look');
      look = value;
    },
    cinematic: {
      setScale(value: number): void {
        calls.push(`scale:${value}`);
        cinematicScale = value;
      },
    },
    setDiagnosticMode(mode: CameraMode): void {
      calls.push(`mode:${mode}`);
      modeName = mode;
    },
    resetCinematic(): void {
      calls.push('reset-cinematic');
      cinematicScale = 0.4;
    },
  };
  return {
    calls,
    cameras,
    get look() {
      return look;
    },
    publishPose(): void {
      calls.push('publish-pose');
    },
  };
}
