import type { CameraMode } from '../camera/CameraSystem';

export interface CaptureCameraSceneFields {
  /** Absent preserves the established embodied capture path. */
  cameraMode?: CameraMode;
  /** Normalised cinematic zoom, where 1 is the maximum authored view. */
  cinematicScale?: number;
  /** Embodied pitch; cinematic scenes use the authored orbit elevation. */
  lookPitchDeg: number;
}

export interface ResolvedCaptureCameraSpec {
  mode: CameraMode;
  /** Null means the authored cinematic default, or an embodied scene. */
  cinematicScale: number | null;
}

export interface CaptureCameraMetadata {
  cameraMode: CameraMode;
  /** Actual live cinematic scale, null for embodied captures. */
  cinematicScale: number | null;
}

export interface CaptureCameraStagingPort {
  readonly modeName: CameraMode;
  readonly cinematicScale: number;
  look: { yaw: number; pitch: number };
  readonly cinematic: { setScale(value: number): void };
  setDiagnosticMode(mode: CameraMode): void;
  resetCinematic(): void;
}

/** Validate the optional camera dimension before staging mutates the scene. */
export function resolveCaptureCameraSpec(
  scene: Readonly<Partial<CaptureCameraSceneFields>>,
): ResolvedCaptureCameraSpec {
  const mode = scene.cameraMode ?? 'embodied';
  if (mode !== 'embodied' && mode !== 'cinematic') {
    throw new RangeError(
      `cameraMode must be embodied or cinematic, got ${String(mode)}`,
    );
  }

  const scale = scene.cinematicScale;
  if (scale !== undefined) {
    if (mode !== 'cinematic') {
      throw new RangeError('cinematicScale requires cameraMode cinematic');
    }
    if (!Number.isFinite(scale) || scale < 0 || scale > 1) {
      throw new RangeError(
        `cinematicScale must be finite in [0, 1], got ${scale}`,
      );
    }
  }
  if (mode === 'cinematic' && (scene.lookPitchDeg ?? 0) !== 0) {
    throw new RangeError(
      'cinematic captures use the authored orbit elevation; lookPitchDeg must be 0',
    );
  }

  return {
    mode,
    cinematicScale: scale ?? null,
  };
}

/**
 * Stage the established camera controllers without constructing a capture-only
 * camera. Cinematic bearing is adopted from the fully posed embodied view, so
 * the capture host's relative yaw and true-bearing inputs retain their meaning.
 */
export function stageCaptureCamera(
  cameras: CaptureCameraStagingPort,
  scene: Readonly<CaptureCameraSceneFields>,
  resolvedLookYawDeg: number,
  publishEmbodiedPose: () => void,
): ResolvedCaptureCameraSpec {
  const resolved = resolveCaptureCameraSpec(scene);
  if (!Number.isFinite(resolvedLookYawDeg)) {
    throw new RangeError(
      `capture look yaw must be finite, got ${resolvedLookYawDeg}`,
    );
  }

  cameras.setDiagnosticMode('embodied');
  cameras.look = {
    yaw: Math.PI - (resolvedLookYawDeg * Math.PI) / 180,
    pitch: (scene.lookPitchDeg * Math.PI) / 180,
  };
  if (resolved.mode === 'cinematic') {
    // Publish the desired world bearing through the embodied controller first.
    // CameraSystem's existing diagnostic cut then adopts that bearing into its
    // one cinematic controller, with no transition or rival capture camera.
    publishEmbodiedPose();
    cameras.resetCinematic();
    cameras.setDiagnosticMode('cinematic');
    if (resolved.cinematicScale !== null) {
      cameras.cinematic.setScale(resolved.cinematicScale);
    }
  }
  return resolved;
}

/** Actual camera facts for manifests and shots, not the requested scene. */
export function readCaptureCameraMetadata(
  cameras: Pick<CaptureCameraStagingPort, 'modeName' | 'cinematicScale'>,
): CaptureCameraMetadata {
  return {
    cameraMode: cameras.modeName,
    cinematicScale:
      cameras.modeName === 'cinematic' ? cameras.cinematicScale : null,
  };
}

/** Camera-specific caption fields shared by browser and Node evidence paths. */
export function captureCameraDescriptionParts(
  scene: Readonly<Partial<CaptureCameraSceneFields>>,
): string[] {
  return [
    scene.cameraMode === undefined ? null : `camera ${scene.cameraMode}`,
    scene.cinematicScale === undefined
      ? null
      : `cinematic scale ${scene.cinematicScale.toFixed(2)}`,
  ].filter((part): part is string => part !== null);
}
