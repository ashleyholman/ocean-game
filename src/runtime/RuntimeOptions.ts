import type { InteriorCutoutMode } from '../scene/Ocean';
import { parseScotopicStrength } from '../scene/scotopic';
import type { StarDomeAnchor } from '../scene/StarField';
import {
  parseTerrainDrawOrder,
  type TerrainDrawOrder,
} from '../terrain/terrainDrawOrder';
import { parseTimberMode, type TimberMode } from '../vessel/schooner/timberFinish';
import type { WeatherSource } from '../weather/WeatherSystem';

export type RuntimeDepthMode = 'conventional' | 'log' | 'reversed';
export type RuntimeTerrainMode = 'global' | 'synthetic' | 'off';

/**
 * Which sail presentation the rig lofts (M6).
 *
 * - `alive` — the deformable cloth: draft from the aero's own attachment,
 *   twist, luff sag, foot round, aback and flogging. The milestone, and the
 *   default.
 * - `still` — the same cloth with the flogging phase frozen. Everything has
 *   its M6 shape and nothing re-lofts on a clock, which is the arm that
 *   separates "the new shape costs more" from "animating costs more".
 * - `flat` — the pre-M6 presentation, byte-identical to what shipped.
 */
export type RuntimeSailClothMode = 'alive' | 'still' | 'flat';

export interface RuntimeHostFacts {
  /** Viewport dimensions may be zero before the first layout. */
  viewportWidth: number;
  viewportHeight: number;
  screenWidth?: number;
  screenHeight?: number;
  isTouch: boolean;
}

/**
 * Immutable browser-host policy selected before any runtime system is built.
 *
 * URL experiments remain URL experiments; this record only turns their raw
 * string representation into named startup decisions. Runtime systems should
 * not parse query parameters independently.
 */
export interface RuntimeOptions {
  debugMode: string | null;
  /**
   * Whether the full developer shell is available at all.
   *
   * `?debug` in any form opts into it — including the deep links that already
   * existed (`?debug=1`, `?debug=ocean`, `?debug=graphics`…). Without it the
   * session gets the player-facing HUD instead: the same bottom-left pill and
   * the same `\` hide-everything key, over a much smaller set of controls.
   * Nothing about the simulation changes; this decides which interface is
   * built over it.
   */
  debugUiEnabled: boolean;
  fixedPixelRatio?: number;
  /**
   * `?quality=desktop|mobile` — the presentation tier, stated rather than
   * inferred from how wide the window happens to be.
   *
   * The inference is right for a real player and wrong for every capture. A
   * viewport under the threshold selects `OCEAN_QUALITY_MOBILE` during
   * bootstrap — three detail octaves instead of five, a 160x160 ring grid
   * instead of 288x288 — and says nothing about it. The browser pane is 854 px
   * wide and trips it; so does a `--window-size=1280,720` headless Chrome,
   * whose content area is only 633 px tall. Both then produce a completely
   * plausible picture of a renderer nobody asked about. `mobile` exists for
   * the same reason `desktop` does: a tier you meant to test should not depend
   * on finding a small enough window.
   */
  forcedQualityTier: 'desktop' | 'mobile' | null;
  /** Retained for callers that only ever asked the desktop question. */
  forceDesktopQuality: boolean;
  /**
   * `?capture=1` — open the deterministic capture session.
   *
   * Retains the drawing buffer, detaches the frame driver's animation loop and
   * publishes `window.__driftCapture`. See `debug/captureHost.ts`.
   */
  captureHostEnabled: boolean;
  initialOceanTemporalEnabled: boolean;
  depthMode: RuntimeDepthMode;
  depthModeWasRequested: boolean;
  cloudMarchOverride?: number;
  buoyancyLabEnabled: boolean;
  schoonerViewerEnabled: boolean;
  raftEnabled: boolean;
  /** Explicit global slice or the shipping synthetic/open-water policies. */
  terrainMode: RuntimeTerrainMode;
  /** Backward-compatible terrain mount gate; false only for `?terrain=off`. */
  syntheticTerrainEnabled: boolean;
  /**
   * `?terrainOrder=before|after` — which side of the sea terrain is submitted
   * on (TERR-131). `after` ships; `terrainDrawOrder.ts` says why the flip is
   * offered rather than simply taken.
   */
  terrainDrawOrder: TerrainDrawOrder;
  /**
   * Where the star dome sits in depth. `far` (the default) parks it just inside
   * the camera's far plane so terrain and the far sea occlude the catalogue;
   * `?starDome=near` restores the 485 m dome the pass shipped with, which stars
   * drew straight through a headland from. See `STAR_DOME_FAR_FRACTION`.
   */
  starDomeAnchor: StarDomeAnchor;
  /**
   * Voyage clock startup policy. `?voyage=<rate>` opens at a fixed voyage
   * compression (absent = the world's honest 1× default), `?voyage=governed`
   * opens with the rate governed by distance to the nearest land under the
   * `?voyageOmega=<deg/s>` slide budget. Live control after startup belongs
   * to the Voyage panel.
   */
  voyageMode: 'fixed' | 'governed';
  voyageFixedRate?: number;
  voyageOmegaMaxDegPerS?: number;
  /**
   * Weather startup policy. `?weather=off` puts the present wind back to the
   * sea state's own, verbatim — the neutral state, and the A/B half of the
   * house rule that every visible thing ships with its own off switch.
   * `?weather=clear|rain|storm` opens an authored review condition.
   * `?weather=<rate>` multiplies the live weather clock, which otherwise runs
   * at the astronomical calendar's own 30×.
   */
  weatherSource: WeatherSource;
  weatherRate?: number;
  /**
   * Decision D5, as a startup switch: does the sea follow the weather?
   *
   * True is the shipped default and the play behaviour — the wind freshens and
   * the sea builds behind it, then outlives it. `?seaCoupling=independent`
   * opens with the two decoupled, which is the laboratory: the sea stays
   * exactly where a preset or a slider put it while the weather goes on doing
   * what it likes to the wind, so a rough sea under a light air is
   * constructible. Live control after startup belongs to the Weather and Ocean
   * panels.
   */
  seaFollowsWeather: boolean;
  interiorCutoutMode: InteriorCutoutMode;
  interiorCabinViewEnabled: boolean;
  /**
   * `?interiorView=desk` opens seated at the captain's chart desk.
   *
   * The instrument the desk round asked for before it built anything. Every
   * look-iteration on a piece of furniture in the after cabin otherwise costs a
   * walk aft, down the companionway, through the landing and through a door —
   * for one screenshot of a composition that is *fixed*, so it is the same
   * screenshot every time. Normal controls stay live; standing up works and
   * puts you in the cabin on your feet.
   */
  interiorDeskViewEnabled: boolean;
  /**
   * `?interiorView=lookout` opens standing at the foremast lookout.
   *
   * The same instrument as the desk's, for the same reason, with a longer walk
   * behind it: reaching the top otherwise costs a walk forward, a climb over the
   * rail and ten seconds of ratlines — for one screenshot of a composition that
   * is fixed. Normal controls stay live, so Space starts the descent and the
   * whole climb is still there to be done properly when the question is about
   * the climb rather than about the view from the top.
   */
  aloftViewEnabled: boolean;
  initialDirectShadowing: boolean;
  /** `?cloth=alive|still|flat` — the M6 sail-presentation A/B. */
  sailClothMode: RuntimeSailClothMode;
  /**
   * `?scotopic=0|1|<0..1>` — the optional night observer model's strength;
   * absent is Ash's recorded shipping verdict, 0 (off).
   *
   * Here rather than in `scene/scotopic.ts`, which used to read the URL at
   * module-evaluation time. That is the thing the doc comment at the top of
   * this interface forbids, and it forbids it for a reason this one showed:
   * a parameter read during the import graph is read before this function
   * runs, in an order nothing states, from a module that then needs a
   * `typeof window` guard to survive being imported by a test.
   */
  scotopicStrength: number;
  /**
   * `?timber=off|woods|grain|wear` — the timber-materials A/B.
   *
   * Cumulative tiers and `off` ships. It is a page-load switch and cannot be
   * anything else: `woods` is read while the vessel's materials are built and
   * `grain` changes shader SOURCE, which three's program cache is not keyed on.
   */
  timberMode: TimberMode;
  capturePort: number;
  isTouch: boolean;
  isSmallScreen: boolean;
}

/**
 * The synthetic opening remains the default: it is what every baseline was
 * measured against, and the global slice is still an opt-in.
 * `?terrain=global` opts into the whole-world slice; `?terrain=off` restores
 * an empty ocean for baselines.
 */
function parseTerrainMode(params: URLSearchParams): RuntimeTerrainMode {
  const raw = params.get('terrain');
  if (raw === null || raw === 'synthetic') return 'synthetic';
  if (raw === 'global' || raw === 'off') return raw;
  throw new Error(
    `[terrain] unknown ?terrain=${raw} — use global | synthetic | off`,
  );
}

function parseVoyage(params: URLSearchParams): {
  voyageMode: 'fixed' | 'governed';
  voyageFixedRate?: number;
  voyageOmegaMaxDegPerS?: number;
} {
  const raw = params.get('voyage');
  let voyageMode: 'fixed' | 'governed' = 'fixed';
  let voyageFixedRate: number | undefined;
  if (raw === 'governed') {
    voyageMode = 'governed';
  } else if (raw !== null) {
    const rate = Number(raw);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(
        `[voyage] unknown ?voyage=${raw} — use a positive rate multiplier or 'governed'`,
      );
    }
    voyageFixedRate = rate;
  }
  const rawOmega = params.get('voyageOmega');
  let voyageOmegaMaxDegPerS: number | undefined;
  if (rawOmega !== null) {
    const omega = Number(rawOmega);
    if (!Number.isFinite(omega) || omega <= 0) {
      throw new Error(
        `[voyage] unknown ?voyageOmega=${rawOmega} — degrees of land slide per second`,
      );
    }
    voyageOmegaMaxDegPerS = omega;
  }
  return { voyageMode, voyageFixedRate, voyageOmegaMaxDegPerS };
}

/**
 * The M6 cloth is production; `?cloth=flat` restores what shipped before it so
 * the two can be compared in one page load, and `?cloth=still` freezes the
 * flogging clock without giving up the shape.
 */
function parseSailClothMode(params: URLSearchParams): RuntimeSailClothMode {
  const raw = params.get('cloth');
  if (raw === null || raw === 'alive') return 'alive';
  if (raw === 'still' || raw === 'flat') return raw;
  throw new Error(`[cloth] unknown ?cloth=${raw} — use alive | still | flat`);
}

/**
 * The presentation tier, when the URL states one.
 *
 * Throws on anything else, following `?terrain=` and `?depth=`: a capture that
 * misspells the tier it needs must not quietly get the tier the window size
 * would have chosen, which is precisely the failure this parameter exists to
 * prevent.
 */
function parseQualityTier(
  params: URLSearchParams,
): 'desktop' | 'mobile' | null {
  const raw = params.get('quality');
  if (raw === null) return null;
  if (raw === 'desktop' || raw === 'mobile') return raw;
  throw new Error(`[quality] unknown ?quality=${raw} — use desktop | mobile`);
}

function parseWeather(params: URLSearchParams): {
  weatherSource: WeatherSource;
  weatherRate?: number;
} {
  const raw = params.get('weather');
  if (raw === null) return { weatherSource: 'live' };
  if (raw === 'off' || raw === 'neutral') return { weatherSource: 'neutral' };
  if (raw === 'on' || raw === 'live') return { weatherSource: 'live' };
  if (raw === 'clear' || raw === 'rain' || raw === 'storm') {
    return { weatherSource: raw };
  }
  const rate = Number(raw);
  if (!Number.isFinite(rate) || rate < 0) {
    throw new Error(
      `[weather] unknown ?weather=${raw} — use off | live | clear | rain | storm | a non-negative rate multiplier`,
    );
  }
  return { weatherSource: 'live', weatherRate: rate };
}

/** Decision D5's startup switch. See `RuntimeOptions.seaFollowsWeather`. */
function parseSeaCoupling(params: URLSearchParams): boolean {
  const raw = params.get('seaCoupling');
  if (raw === null || raw === 'follow' || raw === 'weather') return true;
  if (raw === 'independent' || raw === 'off') return false;
  throw new Error(
    `[seaCoupling] unknown ?seaCoupling=${raw} — use follow | independent`,
  );
}

function parseDepthMode(params: URLSearchParams): RuntimeDepthMode {
  const raw = params.get('depth');
  if (raw === null || raw === 'conventional') return 'conventional';
  if (raw === 'log' || raw === 'reversed') return raw;
  throw new Error(
    `[depth] unknown ?depth=${raw} — use conventional | log | reversed`,
  );
}

/** Parse the browser-facing startup policy without constructing the runtime. */
export function resolveRuntimeOptions(
  params: URLSearchParams,
  host: RuntimeHostFacts,
): RuntimeOptions {
  const debugMode = params.get('debug');
  const requestedFixedPixelRatio = Number(params.get('fixedDpr'));
  const fixedPixelRatio =
    Number.isFinite(requestedFixedPixelRatio) && requestedFixedPixelRatio > 0
      ? requestedFixedPixelRatio
      : undefined;
  const forcedQualityTier = parseQualityTier(params);
  const forceDesktopQuality = forcedQualityTier === 'desktop';
  const requestedCloudMarch = Math.round(Number(params.get('cloudMarch')));
  const cloudMarchOverride =
    Number.isFinite(requestedCloudMarch) &&
    requestedCloudMarch >= 8 &&
    requestedCloudMarch <= 512
      ? requestedCloudMarch
      : undefined;

  // Some embedders report a zero viewport before first layout. Falling back to
  // the screen prevents a desktop session from latching mobile quality.
  const viewportWidth = host.viewportWidth || host.screenWidth || 1280;
  const viewportHeight = host.viewportHeight || host.screenHeight || 720;
  // A stated tier wins outright, in both directions. The viewport heuristic is
  // a guess about a player's device; a capture is not a guess.
  const isSmallScreen =
    forcedQualityTier !== null
      ? forcedQualityTier === 'mobile'
      : Math.min(viewportWidth, viewportHeight) < 640 ||
        Math.max(viewportWidth, viewportHeight) < 1024;
  const terrainMode = parseTerrainMode(params);

  return {
    debugMode,
    debugUiEnabled: !params.has('player'),
    fixedPixelRatio,
    forcedQualityTier,
    forceDesktopQuality,
    captureHostEnabled: params.get('capture') === '1',
    initialOceanTemporalEnabled: params.get('oceanTaa') === '1',
    depthMode: parseDepthMode(params),
    depthModeWasRequested: params.has('depth'),
    cloudMarchOverride,
    buoyancyLabEnabled: debugMode === 'buoyancy',
    schoonerViewerEnabled: debugMode === 'schooner' || debugMode === 'ship',
    raftEnabled: debugMode === 'raft' || debugMode === 'buoyancy',
    terrainMode,
    syntheticTerrainEnabled: terrainMode !== 'off',
    terrainDrawOrder: parseTerrainDrawOrder(params.get('terrainOrder')),
    starDomeAnchor: params.get('starDome') === 'near' ? 'near' : 'far',
    ...parseVoyage(params),
    ...parseWeather(params),
    seaFollowsWeather: parseSeaCoupling(params),
    interiorCutoutMode:
      params.get('interiorCutout') === 'stencil' ? 'stencil' : 'shader',
    interiorCabinViewEnabled: params.get('interiorView') === 'cabin',
    interiorDeskViewEnabled: params.get('interiorView') === 'desk',
    aloftViewEnabled: params.get('interiorView') === 'lookout',
    initialDirectShadowing: params.get('directOcclusion') !== '0',
    sailClothMode: parseSailClothMode(params),
    scotopicStrength: parseScotopicStrength(params.get('scotopic')),
    timberMode: parseTimberMode(params.get('timber')),
    capturePort: Number(params.get('capturePort') ?? 5199) || 5199,
    isTouch: host.isTouch,
    isSmallScreen,
  };
}
