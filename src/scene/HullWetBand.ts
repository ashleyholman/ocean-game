import * as THREE from 'three';
import type { WakeSources } from '../vessel/WakeSources';

/** Eight knots keep the 15.5 m hull within roughly one metre of a live cut. */
export const WET_HULL_PROFILE_SAMPLES = 8;

/** One shader/profile knot in hull-local coordinates. */
export interface WetHullBandSample {
  stationIndex: number;
  localZ: number;
  portWaterlineY: number;
  starboardWaterlineY: number;
}

/** Caller-owned, allocation-free downsample of the resolved contact profile. */
export interface WetHullBandProfile {
  count: number;
  readonly samples: readonly WetHullBandSample[];
}

export interface HullWetBandAppearance {
  enabled: boolean;
  /** Height above the resolved waterline over which the wet sheen fades. */
  heightM: number;
  /** Fraction of dry albedo removed at the waterline. */
  darkening: number;
  /** Multiplier on material roughness at the waterline; lower is glossier. */
  roughnessScale: number;
}

function profileSample(): WetHullBandSample {
  return {
    stationIndex: -1,
    localZ: 0,
    portWaterlineY: 0,
    starboardWaterlineY: 0,
  };
}

export function createWetHullBandProfile(): WetHullBandProfile {
  return {
    count: 0,
    samples: Array.from(
      { length: WET_HULL_PROFILE_SAMPLES },
      profileSample,
    ),
  };
}

/**
 * Downsample the complete contact cuts into a longitudinal material profile.
 *
 * Endpoints are always retained. The source buffer is already sorted by the
 * adapter, so interpolation is stable across station reordering and no hull
 * dimension or design draught is reintroduced here.
 */
export function updateWetHullBandProfile(
  sources: Readonly<WakeSources>,
  out: WetHullBandProfile,
): WetHullBandProfile {
  const available = sources.resolvedWaterlineStationCount;
  const count = Math.min(available, WET_HULL_PROFILE_SAMPLES);
  out.count = count;
  if (count === 0) return out;

  for (let i = 0; i < count; i++) {
    const sourceIndex =
      count === 1
        ? Math.floor((available - 1) * 0.5)
        : Math.round((i * (available - 1)) / (count - 1));
    const source = sources.resolvedWaterlineStations[sourceIndex];
    const destination = out.samples[i] as WetHullBandSample;
    destination.stationIndex = source.stationIndex;
    destination.localZ = source.stationLocalZ;
    destination.portWaterlineY = source.portLocal.y;
    destination.starboardWaterlineY = source.starboardLocal.y;
  }

  // Shader loops are fixed-size. Repeat the last real knot so stale values
  // beyond count can never leak in even if a driver evaluates both sides of a
  // uniform branch.
  const last = out.samples[count - 1];
  for (let i = count; i < WET_HULL_PROFILE_SAMPLES; i++) {
    const destination = out.samples[i] as WetHullBandSample;
    destination.stationIndex = last.stationIndex;
    destination.localZ = last.localZ;
    destination.portWaterlineY = last.portWaterlineY;
    destination.starboardWaterlineY = last.starboardWaterlineY;
  }
  return out;
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

function sideWaterlineY(
  sample: Readonly<WetHullBandSample>,
  localX: number,
): number {
  // Model +X is port. Blend only through a narrow centreline strip so points
  // on either shell use their own resolved side of the sloping water plane.
  const linearWeight = clamp01((localX + 0.08) / 0.16);
  const portWeight = linearWeight * linearWeight * (3 - 2 * linearWeight);
  return (
    sample.starboardWaterlineY +
    (sample.portWaterlineY - sample.starboardWaterlineY) * portWeight
  );
}

/** Pure mirror of the shader interpolation, used by the pitching-run gate. */
export function wetHullWaterlineYAt(
  profile: Readonly<WetHullBandProfile>,
  localX: number,
  localZ: number,
): number | null {
  if (profile.count <= 0) return null;
  const first = profile.samples[0];
  if (profile.count === 1 || localZ <= first.localZ) {
    return sideWaterlineY(first, localX);
  }

  const last = profile.samples[profile.count - 1];
  if (localZ >= last.localZ) return sideWaterlineY(last, localX);

  for (let i = 1; i < profile.count; i++) {
    const upper = profile.samples[i];
    if (localZ > upper.localZ) continue;
    const lower = profile.samples[i - 1];
    const span = Math.max(upper.localZ - lower.localZ, 1e-6);
    const t = clamp01((localZ - lower.localZ) / span);
    const lowerY = sideWaterlineY(lower, localX);
    const upperY = sideWaterlineY(upper, localX);
    return lowerY + (upperY - lowerY) * t;
  }
  return sideWaterlineY(last, localX);
}

export const WET_HULL_VERTEX_ANCHOR = '#include <begin_vertex>';
export const WET_HULL_COLOR_ANCHOR = '#include <color_fragment>';
export const WET_HULL_ROUGHNESS_ANCHOR = '#include <roughnessmap_fragment>';

const WET_HULL_FRAGMENT_GLOBALS = /* glsl */ `
#define WET_HULL_PROFILE_SAMPLES ${WET_HULL_PROFILE_SAMPLES}
varying vec3 vWetHullLocalPosition;
uniform float uWetHullEnabled;
uniform float uWetHullProfileCount;
uniform vec4 uWetHullProfile[WET_HULL_PROFILE_SAMPLES];
uniform float uWetHullHeight;
uniform float uWetHullDarkening;
uniform float uWetHullRoughnessScale;

float wetHullResolvedWaterlineY(vec3 localPosition) {
  float lowerZ = -1e6;
  float upperZ = 1e6;
  float lowerY = 0.0;
  float upperY = 0.0;
  for (int i = 0; i < WET_HULL_PROFILE_SAMPLES; i++) {
    if (float(i) >= uWetHullProfileCount) continue;
    vec4 samplePoint = uWetHullProfile[i];
    float portWeight = smoothstep(-0.08, 0.08, localPosition.x);
    float sampleY = mix(samplePoint.z, samplePoint.y, portWeight);
    if (samplePoint.x <= localPosition.z && samplePoint.x > lowerZ) {
      lowerZ = samplePoint.x;
      lowerY = sampleY;
    }
    if (samplePoint.x >= localPosition.z && samplePoint.x < upperZ) {
      upperZ = samplePoint.x;
      upperY = sampleY;
    }
  }
  if (lowerZ < -9e5) {
    lowerZ = upperZ;
    lowerY = upperY;
  }
  if (upperZ > 9e5) {
    upperZ = lowerZ;
    upperY = lowerY;
  }
  float t = clamp(
    (localPosition.z - lowerZ) / max(upperZ - lowerZ, 1e-5),
    0.0,
    1.0
  );
  return mix(lowerY, upperY, t);
}

float wetHullBandMask(vec3 localPosition) {
  if (uWetHullEnabled < 0.5 || uWetHullProfileCount < 0.5) return 0.0;
  float waterlineY = wetHullResolvedWaterlineY(localPosition);
  float heightAbove = localPosition.y - waterlineY;
  // A short fade below the cut avoids a hard seam where the ocean intersects
  // the shell. The visible ribbon itself is above the resolved waterline.
  float lowerEdge = smoothstep(-0.14, 0.02, heightAbove);
  float upperEdge = 1.0 - smoothstep(0.0, max(uWetHullHeight, 0.01), heightAbove);
  return clamp(lowerEdge * upperEdge, 0.0, 1.0);
}
`;

/**
 * Presentation-only wet-shell controller shared by the schooner's exterior
 * paint materials.
 */
export class HullWetBand {
  readonly profile = createWetHullBandProfile();

  private readonly shaderProfile = Array.from(
    { length: WET_HULL_PROFILE_SAMPLES },
    () => new THREE.Vector4(),
  );
  private readonly uniforms = {
    enabled: { value: 0 },
    profileCount: { value: 0 },
    profile: { value: this.shaderProfile },
    height: { value: 0.5 },
    darkening: { value: 0.28 },
    roughnessScale: { value: 0.58 },
  } satisfies Record<string, THREE.IUniform>;

  get enabled(): boolean {
    return this.uniforms.enabled.value > 0.5;
  }

  update(
    sources: Readonly<WakeSources>,
    appearance: Readonly<HullWetBandAppearance>,
  ): void {
    updateWetHullBandProfile(sources, this.profile);
    for (let i = 0; i < WET_HULL_PROFILE_SAMPLES; i++) {
      const sample = this.profile.samples[i];
      this.shaderProfile[i].set(
        sample.localZ,
        sample.portWaterlineY,
        sample.starboardWaterlineY,
        0,
      );
    }
    this.uniforms.profileCount.value = this.profile.count;
    this.uniforms.height.value = Math.max(appearance.heightM, 0.01);
    this.uniforms.darkening.value = Math.min(
      Math.max(appearance.darkening, 0),
      0.8,
    );
    this.uniforms.roughnessScale.value = Math.min(
      Math.max(appearance.roughnessScale, 0.05),
      1,
    );
    this.uniforms.enabled.value =
      appearance.enabled && this.profile.count > 0 ? 1 : 0;
  }

  /** Add the wet ribbon to one existing world-PBR hull material. */
  attach(material: THREE.MeshStandardMaterial): void {
    const baseOnBeforeCompile = material.onBeforeCompile.bind(material);
    const baseCacheKey = material.customProgramCacheKey.bind(material);
    material.onBeforeCompile = (shader, renderer) => {
      baseOnBeforeCompile(shader, renderer);
      for (const anchor of [
        WET_HULL_VERTEX_ANCHOR,
        WET_HULL_COLOR_ANCHOR,
        WET_HULL_ROUGHNESS_ANCHOR,
      ]) {
        const source = anchor === WET_HULL_VERTEX_ANCHOR
          ? shader.vertexShader
          : shader.fragmentShader;
        if (!source.includes(anchor)) {
          throw new Error(
            `HullWetBand: three's physical shader lost anchor "${anchor}".`,
          );
        }
      }

      shader.uniforms.uWetHullEnabled = this.uniforms.enabled;
      shader.uniforms.uWetHullProfileCount = this.uniforms.profileCount;
      shader.uniforms.uWetHullProfile = this.uniforms.profile;
      shader.uniforms.uWetHullHeight = this.uniforms.height;
      shader.uniforms.uWetHullDarkening = this.uniforms.darkening;
      shader.uniforms.uWetHullRoughnessScale = this.uniforms.roughnessScale;

      shader.vertexShader =
        'varying vec3 vWetHullLocalPosition;\n' +
        shader.vertexShader.replace(
          WET_HULL_VERTEX_ANCHOR,
          `${WET_HULL_VERTEX_ANCHOR}\n  vWetHullLocalPosition = position;`,
        );
      shader.fragmentShader =
        WET_HULL_FRAGMENT_GLOBALS +
        shader.fragmentShader
          .replace(
            WET_HULL_COLOR_ANCHOR,
            `${WET_HULL_COLOR_ANCHOR}\n  float wetHullMask = wetHullBandMask(vWetHullLocalPosition);\n  diffuseColor.rgb *= 1.0 - wetHullMask * uWetHullDarkening;`,
          )
          .replace(
            WET_HULL_ROUGHNESS_ANCHOR,
            `${WET_HULL_ROUGHNESS_ANCHOR}\n  roughnessFactor *= mix(1.0, uWetHullRoughnessScale, wetHullMask);`,
          );
    };
    material.customProgramCacheKey = () => `${baseCacheKey()}|wet-hull-v1`;
  }
}
