import {
  CREST_SPRAY_DESKTOP,
  CREST_SPRAY_MOBILE,
  type CrestSprayQuality,
} from '../scene/CrestSpray';
import {
  FOAM_QUALITY_DESKTOP,
  FOAM_QUALITY_MOBILE,
  type FoamQuality,
} from '../scene/FoamField';
import {
  OCEAN_QUALITY_DESKTOP,
  OCEAN_QUALITY_MOBILE,
  type OceanQuality,
} from '../scene/Ocean';

export interface CloudCacheQuality {
  atlasWidth: number;
  atlasHeight: number;
  slotCapacity: number;
}

/**
 * Coordinated presentation budgets selected once at startup.
 *
 * This profile intentionally contains no physical wave-component budget. The
 * physical sea is invariant across device tiers; only presentation resolution,
 * cache storage, shader approximation, and particle capacity vary here.
 */
export interface RuntimeQuality {
  tier: 'desktop' | 'mobile';
  maximumPixelRatio: number;
  ocean: OceanQuality;
  foam: FoamQuality;
  crestSpray: CrestSprayQuality;
  cloudCache: CloudCacheQuality;
}

const CLOUD_CACHE_DESKTOP: CloudCacheQuality = {
  atlasWidth: 6144,
  atlasHeight: 1280,
  slotCapacity: 120,
};

const CLOUD_CACHE_MOBILE: CloudCacheQuality = {
  atlasWidth: 4096,
  atlasHeight: 768,
  slotCapacity: 64,
};

export function resolveRuntimeQuality(
  isSmallScreen: boolean,
  cloudMarchOverride?: number,
): RuntimeQuality {
  const oceanPreset = isSmallScreen
    ? OCEAN_QUALITY_MOBILE
    : OCEAN_QUALITY_DESKTOP;
  const ocean =
    cloudMarchOverride === undefined
      ? oceanPreset
      : { ...oceanPreset, cloudMarch: cloudMarchOverride };

  return isSmallScreen
    ? {
        tier: 'mobile',
        maximumPixelRatio: 1.75,
        ocean,
        foam: FOAM_QUALITY_MOBILE,
        crestSpray: CREST_SPRAY_MOBILE,
        cloudCache: CLOUD_CACHE_MOBILE,
      }
    : {
        tier: 'desktop',
        maximumPixelRatio: 2,
        ocean,
        foam: FOAM_QUALITY_DESKTOP,
        crestSpray: CREST_SPRAY_DESKTOP,
        cloudCache: CLOUD_CACHE_DESKTOP,
      };
}
