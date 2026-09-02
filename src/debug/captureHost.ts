/**
 * `window.__driftCapture` — the only supported way to get a pixel out of this
 * application, and the reason it is the only one.
 *
 * WHAT WAS WRONG BEFORE
 * ---------------------
 * The renderer runs with `preserveDrawingBuffer: false` in every session that
 * is not the buoyancy lab or the schooner viewer. WebGL then declares the
 * default framebuffer's contents undefined once the frame is composited, and
 * Chrome takes that literally: a `readPixels` or a `drawImage` issued from any
 * task other than the one that rendered comes back all zeroes. A console
 * evaluation, a CDP `Runtime.evaluate`, a `setTimeout` continuation, an
 * `await` — every one of those is a new task. That is the black frame in
 * `docs/ocean/OCEAN_LOOK_ROUND_HANDOVER.md` §6, and it was never a timing
 * problem to be slept through. Measured on this branch, 1280×633 headless:
 * same task 21.7 mean luminance, next task 0.0, and `drawImage` sometimes
 * returning a STALE composited frame rather than black — the worse of the two
 * failures, because it looks like a picture.
 *
 * WHAT THE CONTRACT IS NOW
 * ------------------------
 * A capture session opens with `?capture=1`, which does three things nothing
 * else does: it retains the drawing buffer, it detaches the frame driver's
 * animation loop so the only renders are the ones a capture asks for, and it
 * publishes this object. Every shot then renders and reads inside ONE task,
 * and every shot carries `RenderTierFacts` describing the renderer that drew
 * it. `assertRenderTier` runs before any image is returned, so a frame taken
 * at the wrong tier, size, pixel ratio or A/B arm raises instead of arriving.
 *
 * WHY THE ARMS INTERLEAVE
 * -----------------------
 * The project's measurement doctrine is adjacent alternating pairs, because a
 * machine that drifts between two long blocks turns its own drift into the
 * result. Pixels drift too: the foam history integrates, the cloud cache
 * regenerates, the eye adapts. `captureAb` therefore flips the switch between
 * two renders of ONE frozen simulation state rather than photographing the
 * scene twice, so the only difference between the two images is the switch.
 */

import { findSeaState } from '../ocean/presets';
import type { DeckWalker } from '../player/DeckWalker';
import { findStation } from '../vessel/schooner/stations';
import {
  assertRenderTier,
  formatRenderTierStamp,
  type QualityTier,
  type RenderTierFacts,
  type RenderTierRequest,
} from '../render/renderTier';
import type { SimCapability } from '../runtime/diagnostics/SimHandle';
import {
  AB_SWITCHES,
  findAbSwitch,
  readAllAbSwitches,
  type AbSwitch,
  type AbSwitchCapability,
} from './abSwitches';
import {
  createNavigationTelemetry,
  deriveNavigationTelemetry,
} from '../world/navigation';
import { OPENING_UTC_SECONDS } from '../world/openingVoyage';
import { utcDayOfYear } from '../astronomy/AstronomyProvider';
import { buildContactSheet, grab, post, postText, toBlob } from './labCapture';
import type { SheetFrame } from './labCapture';
import {
  captureCameraDescriptionParts,
  readCaptureCameraMetadata,
  resolveCaptureCameraSpec,
  stageCaptureCamera,
  type CaptureCameraMetadata,
  type CaptureCameraSceneFields,
} from './captureSceneCamera';

export type CaptureHostCapability = SimCapability<
  | 'cameras'
  | 'canvas'
  | 'clearFoam'
  | 'lighting'
  | 'ocean'
  | 'poseOnTrueWindAngleDeg'
  | 'refreshLighting'
  | 'refreshWorldLighting'
  | 'renderFrame'
  | 'renderer'
  | 'resetSimulation'
  | 'setFoamFrozen'
  | 'sky'
  | 'stepSimulation'
  | 'warmFoam'
  | 'waves'
  | 'world'
> &
  AbSwitchCapability;

/**
 * Everything that decides what is in front of the camera.
 *
 * Named rather than implied: two captures with the same spec must produce the
 * same pixels, so anything that moves the picture has to be in here. The one
 * deliberate derivation is the world's calendar instant, searched out from the
 * session's opening instant to reach `sunElevationDeg` — an elevation is what
 * a look decision is actually about, and the search is reproducible because
 * its starting point is fixed for the session rather than wherever the clock
 * has wandered to.
 */
export interface CaptureSceneSpec extends CaptureCameraSceneFields {
  /** A `SEA_STATES` preset name. */
  seaState: string;
  /** Wave-field phase. The field is analytic, so this alone fixes the water. */
  waveTimeSeconds: number;
  sunElevationDeg: number;
  /**
   * Where the eye stands: a `stations.ts` name, or `x,z[,y]` in ship frame.
   *
   * Stated, never inherited. Switching to the embodied camera without placing
   * the body first puts the eye wherever the walker happens to have got to —
   * measured on this branch, that is (-0.35, -1.32, 0.25), which is inside the
   * hull, and every frame of a two-hour capture comes out pure black. The
   * capture host stops the animation loop, so there is not even a running
   * simulation to walk the body up onto the deck first.
   */
  stand: string;
  /** Yaw 0 = toward the bow, 180 = the stern. */
  lookYawDeg: number;
  /**
   * Look at a TRUE bearing instead, in degrees clockwise from north.
   *
   * `lookYawDeg` is ship-relative, which is the right frame for a question
   * about the rig or the deck and the wrong one for a question about anything
   * in the world. The synthetic headland sits on a world bearing and the
   * vessel's heading is whatever the voyage gives it, so aiming at land by
   * guessing a yaw is a sweep, not a scene. When set, this wins over
   * `lookYawDeg` and is converted through the live course.
   */
  lookBearingDeg?: number;
  /** Presentation origin of the wave field. */
  originX: number;
  originZ: number;
  /** Frames of ordinary cloud generation before the cache is frozen. */
  cloudWarmFrames: number;
  /**
   * Put her on a point of sail: the signed TRUE wind angle off the bow.
   *
   * Positive is the wind over the port side, so +45 is close-hauled on the port
   * tack, ±90 is a beam reach and 180 is dead downwind. Absent leaves her on
   * whatever the opening voyage gives her, which is what every sheet before this
   * field existed was photographed on.
   *
   * A question about the SAILS is a question about this and almost nothing else
   * — REVIEW_QUEUE 2.6 asks for six things and five of them are points of sail
   * rather than viewpoints. It composes with the rest of the spec rather than
   * replacing any of it: `stand` and `lookYawDeg` stay ship-relative and mean
   * the same thing at any heading, and `lookBearingDeg` still resolves through
   * the live course, so aiming at the headland survives being put on a beat.
   *
   * `VesselRuntime.poseOnTrueWindAngleDeg` is where the three things this needs
   * — the tow, the yaw and the sheets — are done together, and why.
   */
  trueWindAngleDeg?: number;
  /**
   * Which day of the year the solar search runs within. Absent is the opening.
   *
   * `settleSun` walks 1440 minutes from a FIXED base instant, and until this
   * existed that base was the opening day and only the opening day. An elevation
   * is all most look questions need, so nobody noticed what it costs the ones
   * that do not: the moon's phase and its position are functions of the date,
   * and on the opening day the moon is **9.7 % illuminated and below the
   * horizon**. Both arms of a moonlight A/B are then identically zero, which is
   * why REVIEW_QUEUE 3.2 could not be photographed at all.
   *
   * Offsetting the base by whole UTC days keeps the search window a whole day,
   * so the sun is still reachable wherever the season allows — and the season is
   * the other thing this moves. A frame at "sun 38°" on day 200 is a different
   * sky from the same request on day 15; the manifest records the elevation that
   * was drawn, as always, but the caption cannot tell you it is winter.
   */
  dayOfYear?: number;
}

export const DEFAULT_SCENE: CaptureSceneSpec = {
  seaState: 'CURRENT_MODERATE',
  waveTimeSeconds: 120,
  sunElevationDeg: 38,
  // The port gangway abreast the hatch: open water over the rail with the
  // deck and rig in frame, which is the condition most ocean look decisions
  // are actually about.
  stand: 'Waist',
  lookYawDeg: 140,
  lookPitchDeg: 0,
  originX: 0,
  originZ: 0,
  cloudWarmFrames: 72,
};

/** Shared caption policy for live captures and deterministic unit evidence. */
export function describeCaptureScene(
  scene: Readonly<Partial<CaptureSceneSpec>>,
): string {
  return [
    scene.seaState ?? DEFAULT_SCENE.seaState,
    `sun ${scene.sunElevationDeg ?? DEFAULT_SCENE.sunElevationDeg}°`,
    scene.dayOfYear === undefined ? null : `day ${scene.dayOfYear}`,
    scene.trueWindAngleDeg === undefined
      ? null
      : `wind ${scene.trueWindAngleDeg}° off the bow`,
    ...captureCameraDescriptionParts(scene),
  ]
    .filter((part) => part !== null)
    .join(' · ');
}

export interface CaptureSurfaceSpec {
  tier: QualityTier;
  cssWidth: number;
  cssHeight: number;
  pixelRatio: number;
}

export interface CaptureShot extends CaptureCameraMetadata {
  label: string;
  /** PNG data URL of the settled frame. */
  dataUrl: string;
  tier: RenderTierFacts;
  /**
   * The sun's elevation in the frame that was actually drawn.
   *
   * The scene REQUESTS an elevation and `settleSun` walks a day in two-minute
   * steps to the nearest instant it can find. Nearest is not equal, and on a
   * date whose sun never gets that high it is not even close — a sheet
   * captioned "sun 34°" over a frame at the day's maximum of 21° is the exact
   * shape of silent substitution this host exists to refuse. Same rule as the
   * A/B arms: report what took, not what was asked.
   */
  sunElevationDeg: number;
  /**
   * The moon in the frame that was drawn: where it is, how lit, how strong.
   *
   * Here for the same reason `sunElevationDeg` is, and it catches the same class
   * of thing. A moonlight sheet whose scene forgot its `dayOfYear` is a pair of
   * frames with no moon in them, and `moonPower` 0 says so in one number where
   * two black seas say nothing at all. `power` is post-gate — the phase, the
   * elevation ramp and the sun's own washout are already in it — so zero means
   * the moon contributes nothing to this frame whatever the almanac says.
   */
  moonElevationDeg: number;
  moonIlluminatedFraction: number;
  moonPower: number;
  /**
   * The signed true wind angle off the bow this scene was staged on, or null
   * when it named none and she is on the voyage's own point of sail.
   *
   * The staged value rather than a re-derivation, and that is honest here: the
   * pose puts the hull on a captive tow at the commanded heading, so the tow
   * holds the angle for the whole of the capture and nothing is left free to
   * drift off it.
   */
  trueWindAngleDeg: number | null;
}

export interface AbSwitchSummary {
  name: string;
  summary: string;
  scope: AbSwitch['scope'];
  defaultArm: string;
  arms: string[];
}

export interface CaptureAbRequest {
  switchName: string;
  /** Two or more arm values. Defaults to the switch's own arms. */
  arms?: readonly string[];
  scenes?: readonly Partial<CaptureSceneSpec>[];
  surface: CaptureSurfaceSpec;
  /** Alternating passes over the arms. Two or more proves the flip is stable. */
  repeats?: number;
}

export interface CaptureAbResult {
  switchName: string;
  scope: AbSwitch['scope'];
  summary: string;
  defaultArm: string;
  shots: CaptureShot[];
  scenes: CaptureSceneSpec[];
  tierStamp: string;
}

export interface CaptureGlobal {
  ready: boolean;
  /** Live tier facts, without capturing anything. */
  tier(surface?: CaptureSurfaceSpec): RenderTierFacts;
  /** Registry metadata, so the CLI never duplicates the switch table. */
  switches(): AbSwitchSummary[];
  /** Pin the surface and settle one scene. Returns the tier it settled at. */
  stage(
    scene: Partial<CaptureSceneSpec>,
    surface: CaptureSurfaceSpec,
  ): RenderTierFacts;
  /** One atomic render-and-read at the currently staged scene. */
  shot(
    label: string,
    surface: CaptureSurfaceSpec,
    expectedSwitches?: Record<string, string>,
  ): CaptureShot;
  /**
   * Move one live switch to an arm. A no-op for a page-load switch, whose arm
   * was decided by the URL this page was opened with.
   */
  setSwitch(name: string, arm: string): void;
  /** The whole interleaved A/B, in one page, for a `live` switch. */
  captureAb(request: CaptureAbRequest): CaptureAbResult;
  /** Compose labelled frames — from this page or another — into one sheet. */
  compose(
    frames: ReadonlyArray<{ label: string; dataUrl: string }>,
    options: {
      title: string;
      subtitle: string;
      columns: number;
      cellWidth?: number;
    },
  ): Promise<string>;
  /** Pixel difference between two captured frames. */
  diff(first: string, second: string): Promise<FrameDifference>;
  /**
   * The same difference as a picture, amplified so a reviewer can see it.
   *
   * A frame that changes by a mean of one level out of 255 is a real change
   * and an invisible one — the star-dome A/B moves individual stars by 226
   * levels each while moving the whole frame by 1.2, and side by side that
   * reads as two identical night scenes. This is the panel that says WHERE.
   */
  diffImage(first: string, second: string, gain?: number): Promise<string>;
  /** POST an artefact to `tools/capture-server.mjs`. */
  publish(name: string, dataUrl: string): Promise<boolean>;
  publishText(name: string, text: string): Promise<boolean>;
}

/**
 * How far apart two frames are, in pixels rather than in PNG bytes.
 *
 * PNG is entropy coded, so a one-level change in one corner rewrites most of
 * the file and a byte comparison can only ever answer "identical or not". A
 * capture tool has to be able to say HOW different, because the useful
 * questions here are all comparative: is this A/B bigger than the noise floor
 * between two identically staged pages?
 */
export interface FrameDifference {
  pixels: number;
  /** Pixels where any channel differs at all. */
  differing: number;
  differingPercent: number;
  /** Largest single-channel difference, 0-255. */
  maxChannelDelta: number;
  /** Mean per-pixel max-channel difference, 0-255. */
  meanChannelDelta: number;
  /**
   * Mean SIGNED luma shift, second frame minus first, in sRGB code levels.
   *
   * `meanChannelDelta` is unsigned, and for a question about FILL that is the
   * wrong statistic twice over. It cannot tell "the whole deck is two levels
   * brighter" from "nothing moved but every specular edge resampled", and the
   * second is what an unsigned mean mostly measures on a frame full of rigging
   * and glitter. A number near zero here beside a large `meanChannelDelta` says
   * exactly that: the arms differ, but not in overall level.
   */
  meanSignedLuma: number;
}

declare global {
  interface Window {
    __driftCapture?: CaptureGlobal;
  }
}

/** `?capture=1` — the session opts into the capture contract. */
export function captureRequested(params: URLSearchParams): boolean {
  return params.get('capture') === '1';
}

/** The switch registry, flattened for transport across the CDP boundary. */
export function abSwitchSummaries(): AbSwitchSummary[] {
  return AB_SWITCHES.map((entry) => ({
    name: entry.name,
    summary: entry.summary,
    scope: entry.scope,
    defaultArm: entry.defaultArm,
    arms: [...entry.arms],
  }));
}

function imageData(canvas: HTMLCanvasElement): Uint8ClampedArray {
  return canvas
    .getContext('2d', { willReadFrequently: true })!
    .getImageData(0, 0, canvas.width, canvas.height).data;
}

function dataUrlToCanvas(dataUrl: string): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext('2d')!.drawImage(image, 0, 0);
      resolve(canvas);
    };
    image.onerror = () => reject(new Error('could not decode a captured frame'));
    image.src = dataUrl;
  });
}

export interface CaptureHostDependencies {
  params: URLSearchParams;
  sim: CaptureHostCapability;
  /** The runtime tier chosen at bootstrap — the thing a capture must verify. */
  tier: QualityTier;
  /** True when `?fixedDpr=` pinned the ratio, disabling the adaptive walk. */
  adaptiveResolutionPinned: boolean;
  deckWalker?: DeckWalker;
  /**
   * Snap the eye's exposure adaptation to its target.
   *
   * The meter has a multi-second time constant by design, and a capture
   * session has no seconds — a scrubbed clock would otherwise be photographed
   * through an eye still adapted to the hour the page booted into.
   */
  snapEyeAdaptation?(): void;
  /** Detach the frame driver so the only renders are the capture's own. */
  stopAnimationLoop(): void;
  waitPresentedFrames(count: number): Promise<void>;
}

export async function startCaptureHost(
  dependencies: CaptureHostDependencies,
): Promise<void> {
  const {
    params,
    sim,
    tier,
    adaptiveResolutionPinned,
    deckWalker,
    snapEyeAdaptation,
    stopAnimationLoop,
    waitPresentedFrames,
  } = dependencies;
  if (!captureRequested(params)) return;

  // Real frames first, and this is not politeness. Materials compile, the
  // world probe publishes, and the walker's body finds the deck it is standing
  // on — all of which happen in the frame loop, so a session that detaches the
  // loop at once never gets any of them.
  await waitPresentedFrames(3);

  // Then the loop goes, and stays gone. While it runs, the adaptive-resolution
  // policy can move the pixel ratio between two frames of one comparison, the
  // foam history keeps integrating, and a shot races a render nobody asked
  // for.
  stopAnimationLoop();
  sim.world.setPaused(true);

  const capture = buildCaptureGlobal({
    sim,
    tier,
    adaptiveResolutionPinned,
    deckWalker,
    snapEyeAdaptation,
  });
  window.__driftCapture = capture;
  console.info('[capture] ready', formatRenderTierStamp(capture.tier()));
}

export interface CaptureGlobalDependencies {
  sim: CaptureHostCapability;
  tier: QualityTier;
  adaptiveResolutionPinned: boolean;
  deckWalker?: DeckWalker;
  snapEyeAdaptation?(): void;
}

export function buildCaptureGlobal(
  dependencies: CaptureGlobalDependencies,
): CaptureGlobal {
  const { sim, tier, adaptiveResolutionPinned, deckWalker, snapEyeAdaptation } =
    dependencies;

  /**
   * The instant every solar search starts from — a CONSTANT, not the clock.
   *
   * This was the session's own `worldInstantUtcSeconds`, read once at startup,
   * and it was wrong in a way only a cross-page control could show. The world
   * clock runs while the host waits out its settling frames, and the calendar
   * runs at 30x, so two pages that boot a second apart begin their search from
   * instants half a minute of world time apart. The search matches ELEVATION,
   * which both then reach — at different azimuths, under a different sky.
   * Measured before this was pinned: two pages asked for the identical scene
   * and differed over 98% of their pixels, mean 33.7 of 255.
   *
   * `OPENING_UTC_SECONDS` is the application's own fixed opening instant, so
   * "sun 48 degrees" now names ONE instant, in every page and every session.
   */
  const baseInstant = OPENING_UTC_SECONDS;

  /** The day the opening instant falls on, and the origin `dayOfYear` counts from. */
  const OPENING_DAY_OF_YEAR = utcDayOfYear(OPENING_UTC_SECONDS);
  const SECONDS_PER_DAY = 86400;

  /**
   * The instant a scene's solar search starts from.
   *
   * A whole number of UTC days off the opening, so the window the search walks
   * is still exactly one day and every property that made `baseInstant` worth
   * pinning survives: it is a constant, it is the same in every page, and the
   * same request names the same instant. What it moves is the date — the
   * season, and with it the moon's phase and where the moon is, which is the
   * whole reason the field exists. `AstronomyProvider` has a more careful
   * `setDayOfYearPreservingLocalApparentSolarTime`, and it is not what this
   * wants: it preserves an apparent solar TIME, and the search that follows is
   * about to discard the time of day anyway.
   */
  const baseInstantForDay = (dayOfYear?: number): number => {
    if (dayOfYear === undefined) return baseInstant;
    if (!Number.isInteger(dayOfYear) || dayOfYear < 1 || dayOfYear > 366) {
      throw new RangeError(
        `dayOfYear must be a whole day in [1, 366], got ${dayOfYear}`,
      );
    }
    return baseInstant + (dayOfYear - OPENING_DAY_OF_YEAR) * SECONDS_PER_DAY;
  };

  const pinSurface = (surface: CaptureSurfaceSpec): void => {
    sim.renderer.setPixelRatio(surface.pixelRatio);
    sim.renderer.setSize(surface.cssWidth, surface.cssHeight, false);
    sim.cameras.setViewport(surface.cssWidth, surface.cssHeight);
  };

  const readTier = (surface?: CaptureSurfaceSpec): RenderTierFacts => {
    const gl = sim.renderer.getContext();
    const attributes = gl.getContextAttributes();
    const pixelRatio = sim.renderer.getPixelRatio();
    return {
      tier,
      // The live compiled define, not the tier's intent: the profile probe can
      // lower it under a perfectly correct tier, and that is a substitution a
      // look capture must not survive.
      detailOctaves: Number(sim.ocean.material.defines.DETAIL_OCTAVES),
      oceanRings: sim.ocean.quality.rings,
      oceanSectors: sim.ocean.quality.sectors,
      cssWidth:
        surface?.cssWidth ?? Math.round(gl.drawingBufferWidth / pixelRatio),
      cssHeight:
        surface?.cssHeight ?? Math.round(gl.drawingBufferHeight / pixelRatio),
      pixelRatio,
      backingWidth: gl.drawingBufferWidth,
      backingHeight: gl.drawingBufferHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      adaptiveResolutionPinned,
      animationLoopStopped: true,
      preserveDrawingBuffer: attributes?.preserveDrawingBuffer === true,
      switches: readAllAbSwitches(sim),
    };
  };

  /** One render and one read, in one task. Nothing may await between them. */
  const takeShot = (
    label: string,
    surface: CaptureSurfaceSpec,
    expectedSwitches?: Record<string, string>,
  ): CaptureShot => {
    pinSurface(surface);
    sim.stepSimulation(0);
    sim.renderFrame();
    const image = grab(sim.canvas);
    const facts = readTier(surface);
    const request: RenderTierRequest = {
      tier: surface.tier,
      cssWidth: surface.cssWidth,
      cssHeight: surface.cssHeight,
      pixelRatio: surface.pixelRatio,
      switches: expectedSwitches,
    };
    assertRenderTier(request, facts);
    return {
      label,
      dataUrl: image.toDataURL('image/png'),
      tier: facts,
      ...readCaptureCameraMetadata(sim.cameras),
      sunElevationDeg: sunElevationDeg(),
      moonElevationDeg: moonElevationDeg(),
      moonIlluminatedFraction: Number(
        sim.lighting.moonIlluminatedFraction.toFixed(4),
      ),
      moonPower: Number(sim.lighting.moonPower.toFixed(5)),
      trueWindAngleDeg: stagedTrueWindAngleDeg,
    };
  };

  /** The sun's elevation right now, from the light the frame was drawn by. */
  const sunElevationDeg = (): number => {
    const y = Math.min(Math.max(sim.lighting.sunDirection.y, -1), 1);
    return Number(((Math.asin(y) * 180) / Math.PI).toFixed(2));
  };

  /** The moon's, from the same place and for the same reason. */
  const moonElevationDeg = (): number => {
    const y = Math.min(Math.max(sim.lighting.moonDirection.y, -1), 1);
    return Number(((Math.asin(y) * 180) / Math.PI).toFixed(2));
  };

  /**
   * The point of sail the last staging put her on; null when it named none.
   *
   * Held here rather than passed to `shot`, because `shot` is also called
   * directly by `ab-sheet.mjs` across two pages and by the determinism recheck,
   * and every one of those wants the caption to describe the scene that is
   * standing rather than one it has to be told about again.
   */
  let stagedTrueWindAngleDeg: number | null = null;

  /**
   * Settle frames, stepped at a fixed delta.
   *
   * Not `stepSimulation(0)`. The existing contact sheets step at zero and get
   * away with it because they run as async work INSIDE a live animation loop,
   * so the loop's own real-delta frames integrate the sky, the cloud gate, the
   * world probe and the eye's adaptation between their awaits. A capture
   * session detaches that loop, and a scene settled entirely at dt = 0 comes
   * out with none of them advanced: measured here, a midday sea photographed
   * that way is pure black with two faintly lit deck beams in it.
   *
   * A fixed delta keeps determinism — a fixed count of identical steps — while
   * letting everything that integrates actually arrive. The same recipe the
   * perf harness uses to reach a representative frame.
   */
  const SETTLE_DELTA_SECONDS = 1 / 60;

  const settle = (frames: number, surface: CaptureSurfaceSpec): void => {
    for (let index = 0; index < frames; index++) {
      pinSurface(surface);
      sim.stepSimulation(SETTLE_DELTA_SECONDS);
      sim.renderFrame();
    }
  };

  /**
   * Frames that republish uniforms and nothing else — dt = 0, deliberately.
   *
   * The opposite call from `settle`, and both are right where they are used.
   * Staging needs real deltas because everything it is waiting for is an
   * integrator. Flipping an A/B arm needs the reverse: nothing may integrate
   * between the two arms, because whatever does becomes part of the answer.
   *
   * That is not hypothetical. `setPaused` stops the calendar, not the ship, so
   * three frames at 1/60 s moved the eye 7 mm along the deck and 6 mm across
   * it, and forty-eight moved it 64 mm. Sub-pixel is not small in a frame full
   * of rigging, glitter and foam: MEASURED at a 27-degree sun, the same arm
   * photographed twice through a 1/60 s settle differed by a mean of 3.33 of
   * 255 over 48 % of the frame, growing to 24.7 at forty-eight frames — while
   * its SIGNED luma stayed at zero, which is the signature of a picture that
   * moved rather than one that changed. `sunDomeMean` measured 3.34 against
   * that 3.33, and its sheet was a photograph of the harness.
   *
   * At dt = 0 the eye does not move at all — the same coordinates to six
   * decimal places — and the same arm twice comes out BIT-IDENTICAL: 0 % of
   * pixels, max 0. Against that floor `sunDomeMean` measures a signed +2.32
   * levels and `legacyToneCurve` +13.9.
   */
  const republish = (frames: number, surface: CaptureSurfaceSpec): void => {
    for (let index = 0; index < frames; index++) {
      pinSurface(surface);
      sim.stepSimulation(0);
      sim.renderFrame();
    }
  };

  /**
   * Walk the world clock to the instant nearest a solar elevation.
   *
   * Deliberately searched from a fixed base rather than from wherever the
   * clock currently sits — `labCapture.settleSunElevation` does the latter,
   * which makes its answer depend on session history. "Same request, same
   * pixels" cannot survive a path-dependent sun.
   */
  const settleSun = (
    targetElevationDeg: number,
    dayOfYear?: number,
  ): number => {
    const state = sim.world.state;
    const searchBase = baseInstantForDay(dayOfYear);
    let bestInstant = searchBase;
    let bestElevation = 0;
    let bestError = Infinity;
    for (let minute = 0; minute < 1440; minute += 2) {
      state.worldInstantUtcSeconds = searchBase + minute * 60;
      sim.refreshLighting();
      const y = Math.min(Math.max(sim.lighting.sunDirection.y, -1), 1);
      const elevationDeg = (Math.asin(y) * 180) / Math.PI;
      const error = Math.abs(elevationDeg - targetElevationDeg);
      if (error < bestError) {
        bestError = error;
        bestInstant = state.worldInstantUtcSeconds;
        bestElevation = elevationDeg;
      }
    }
    state.worldInstantUtcSeconds = bestInstant;
    sim.refreshLighting();
    return bestElevation;
  };

  /**
   * Put the body where the scene says, and refuse to photograph anything if it
   * would not go. A station the walker rejects leaves the eye wherever it was,
   * which is the difference between a capture of the ship's waist and a
   * capture of the inside of her hull.
   */
  const placeEye = (stand: string): void => {
    if (!deckWalker) {
      throw new Error(
        `scene asks to stand at '${stand}' but this session has no deck ` +
          `walker — the schooner is not mounted`,
      );
    }
    const coordinates = stand.split(',').map((part) => Number(part.trim()));
    const placed =
      coordinates.length >= 2 && coordinates.every(Number.isFinite)
        ? deckWalker.placeAt(coordinates[0], coordinates[1], coordinates[2])
        : (() => {
            const station = findStation(stand);
            if (!station) {
              throw new Error(
                `unknown stand '${stand}' — use a stations.ts name or x,z[,y]`,
              );
            }
            return deckWalker.placeAt(station.x, station.z, station.fromY);
          })();
    if (!placed) {
      throw new Error(
        `the walker refused to stand at '${stand}': the eye would be somewhere ` +
          `other than the scene claims`,
      );
    }
    // Held, or seconds of heel slip on a trimmed deck move the body between
    // the two arms of the A/B.
    deckWalker.setHeld(true);
  };

  /** A true bearing, turned into the ship-relative yaw the camera speaks. */
  const resolveLookYawDeg = (scene: CaptureSceneSpec): number => {
    if (scene.lookBearingDeg === undefined) return scene.lookYawDeg;
    const course = deriveNavigationTelemetry(
      sim.world.state,
      createNavigationTelemetry(),
    ).trueCourseRad;
    if (course === null || !Number.isFinite(course)) {
      throw new Error(
        `scene asks to look at bearing ${scene.lookBearingDeg}°, but the world ` +
          `reports no true course to convert it through`,
      );
    }
    const courseDeg = (course * 180) / Math.PI;
    return ((scene.lookBearingDeg - courseDeg) % 360 + 360) % 360;
  };

  const stage = (
    partial: Partial<CaptureSceneSpec>,
    surface: CaptureSurfaceSpec,
  ): RenderTierFacts => {
    const scene: CaptureSceneSpec = { ...DEFAULT_SCENE, ...partial };
    // Refuse invalid camera requests before resetting any simulation state.
    resolveCaptureCameraSpec(scene);
    pinSurface(surface);

    // Release every hold the PREVIOUS scene put on, before restarting. This is
    // the difference between a sheet whose second scene is reproducible and
    // one whose second scene inherits a frozen foam field from the first:
    // `resetSimulation` clears the wave freeze and the foam contents, but
    // nothing there knows about the foam's presentation latch, so a `warmFoam`
    // into a frozen field warms nothing.
    //
    // The cloud freeze is now cleared by `CloudDome.reset` as well — a frozen
    // dome is a hold on a cache that no longer has contents. Kept here so the
    // three holds this function set are visibly released in one place.
    sim.setFoamFrozen(false);
    sim.sky.cloudDome.setFrozen(false);
    sim.waves.frozen = false;

    // A full restart, not a nudge: t = 0, the named sea, the named origin.
    // Anything short of this leaves the previous scene's wave phase and foam
    // in the picture, which is how "same request, same pixels" quietly stops
    // being true after the second scene of a sheet.
    sim.world.setPaused(true);
    sim.world.state.worldSecondsPerRealSecond = 0;
    sim.resetSimulation(
      findSeaState(scene.seaState),
      scene.originX,
      scene.originZ,
    );
    sim.waves.setTime(scene.waveTimeSeconds);
    settleSun(scene.sunElevationDeg, scene.dayOfYear);

    // The point of sail BEFORE the eye and before the look, because both of the
    // latter are read through the heading this sets: `lookBearingDeg` converts
    // through the live true course, and the walker is placed in ship frame.
    stagedTrueWindAngleDeg = null;
    if (scene.trueWindAngleDeg !== undefined) {
      // One republishing step first, at dt = 0 so nothing integrates. The
      // present wind is pushed to `WorldWind` inside the frame update, so
      // immediately after a `resetSimulation` that adopted a different sea it is
      // one frame stale — and a point of sail resolved against the previous
      // scene's wind is off by however far the two presets' winds differ.
      sim.stepSimulation(0);
      stagedTrueWindAngleDeg = Number(
        sim.poseOnTrueWindAngleDeg(scene.trueWindAngleDeg).toFixed(2),
      );
    }

    placeEye(scene.stand);
    stageCaptureCamera(
      sim.cameras,
      scene,
      resolveLookYawDeg(scene),
      () => sim.stepSimulation(0),
    );

    sim.clearFoam();
    sim.warmFoam();

    // The cloud cache is a real cache: photographed cold it shows a partly
    // built sky. One ordinary generation at the frozen camera, then hold it,
    // so both arms of the A/B look at the same clouds.
    //
    // These are also the frames in which everything that integrates catches up
    // with the instant the clock was scrubbed to: the sky LUT, the world
    // probe, the vessel's attitude and the eye's adaptation. Each of them now
    // starts those frames from a restored state rather than from the previous
    // scene's, which is what makes a fixed frame count mean the same thing
    // twice.
    sim.sky.cloudDome.setFrozen(false);
    settle(scene.cloudWarmFrames, surface);

    // THEN rebase the cloud cache, and freeze it on the very next frame.
    //
    // Order matters more than anything else in this function. The cache is
    // normally filled by an amortized generation spread over sixty frames,
    // whose tile order comes off a round-robin cursor — so a scene warmed for
    // a fixed number of frames freezes part-way through a tile order, and if
    // the cursor is somewhere different each time, the same request gives a
    // visibly different sky (measured: 95% of pixels, mean 4.4 of 255).
    // `requestDisplayRebase` is not amortized: it re-renders every resident
    // tile at once from the current uniforms. Freezing immediately after it
    // therefore captures a cache that is complete and is a pure function of
    // the settled scene.
    //
    // `resetSimulation` now rewinds that cursor too (`CloudDome.reset`), so
    // the two defences are independent: the reset makes the amortized order
    // the same on every staging, and the rebase makes the frozen cache
    // complete regardless of where the order got to. Neither replaces the
    // other — a rebase renders only the tiles the pool has resident, and pool
    // residency is itself history-dependent.
    sim.sky.requestCloudCacheRebase();
    settle(1, surface);
    sim.sky.cloudDome.setFrozen(true);

    // Now hold everything that integrates. From here the scene is a still
    // life, and the only thing left free to change is the switch under test.
    sim.waves.frozen = true;
    sim.setFoamFrozen(true);
    // The world probe on its own cadence would otherwise publish between the
    // two arms.
    sim.refreshWorldLighting();
    settle(2, surface);

    // The wave phase the scene NAMED, restored after the settle stepped past
    // it. Frozen water does not advance, so this is the phase every shot of
    // this scene is taken at.
    sim.waves.setTime(scene.waveTimeSeconds);
    settle(1, surface);

    // The adaptation snap goes LAST, after every frame that could move the
    // meter: the exposure a shot renders through should be the snapped value,
    // not the snapped value plus three frames of drift. The meter has a
    // multi-second constant and a capture session has no seconds, so it is
    // snapped rather than waited out.
    //
    // This is ordering hygiene, and it was NEVER the fix for the exposure
    // creep — measured both ways, the residue was unchanged (mean 0.1388
    // before, 0.1363 after, which is noise). The creep was in the meter's own
    // state: a four-second low pass with a first-frame latch that climbs all
    // session and never returns. That is now rewound by `resetSimulation`
    // through the presentation port's `resetAdaptation`, which clears the
    // sky's exposure and both of its amortized cursors, the scotopic rod, and
    // the schooner's metered interior gain.
    //
    // Both calls are still needed and they answer different questions. The
    // reset asks nothing and is issued before anybody has been placed; this
    // snap asks "where should the eye be, given where the body is standing",
    // which is only answerable after `placeEye`. See
    // docs/graphics/AGENT_INSPECTION.md.
    snapEyeAdaptation?.();

    return readTier(surface);
  };

  /**
   * The caption half of a scene: what makes THIS row different from that one.
   *
   * Kept in one place because the two capture paths — live in this file,
   * page-load in `ab-sheet.mjs` — build the same label separately, and a sheet
   * whose four rows are all captioned "CURRENT_MODERATE · sun 38°" is a sheet
   * nobody can read. Only the fields the scene actually named appear, so an
   * ordinary open-water sheet's captions are unchanged.
   */
  const captureAb = (request: CaptureAbRequest): CaptureAbResult => {
    const entry = findAbSwitch(request.switchName);
    const arms = request.arms ?? entry.arms;
    if (arms.length < 2) {
      throw new Error(`an A/B needs at least two arms; got ${arms.length}`);
    }
    if (entry.scope !== 'live' || !entry.apply) {
      throw new Error(
        `'${entry.name}' is a page-load switch: it changes shader source, which ` +
          `three's program cache is not keyed on, so flipping it in place would ` +
          `leave compiled programs running the old code. Capture it with one ` +
          `page per arm — tools/ab-sheet.mjs does that automatically.`,
      );
    }
    const apply = entry.apply;
    const { surface } = request;
    const repeats = Math.max(1, request.repeats ?? 1);
    const scenes = (request.scenes ?? [{}]).map((partial) => ({
      ...DEFAULT_SCENE,
      ...partial,
    }));
    const shots: CaptureShot[] = [];

    for (const scene of scenes) {
      stage(scene, surface);
      // Adjacent alternating arms over ONE settled state. Not two passes: the
      // foam, the cloud cache and the eye all drift, and a scene that drifts
      // between two long blocks becomes part of the answer.
      for (let repeat = 0; repeat < repeats; repeat++) {
        for (const arm of arms) {
          apply(sim, arm);
          // Re-run the lighting the arm may have moved, BEFORE photographing
          // it. Half of this registry's switches move a term the CPU lighting
          // model computes — the ambient fill above all — and that term reaches
          // the picture through `refreshLighting`/`refreshWorldLighting`, not
          // through a uniform the next render happens to upload. Without this,
          // flipping `sunDomeMean` moved the fill by 0.85x and moved the frame
          // by nothing: measured, an unsigned mean of 3.34 against a same-arm
          // floor of 3.33. With it, the same flip moves the frame by a signed
          // +2.32 sRGB levels over 99 % of it. A switch that cannot be seen is
          // indistinguishable from a switch that does nothing, and this
          // instrument's whole job is to tell those two apart.
          sim.refreshLighting();
          sim.refreshWorldLighting();
          // Frames enough for the uniform republish and the exposure re-snap
          // that the colour-pipeline listeners do on a flip to reach the GPU —
          // at dt = 0, so the ship does not sail out from under the comparison.
          republish(3, surface);
          shots.push(
            takeShot(
              `${entry.name}=${arm} · ${describeCaptureScene(scene)}` +
                (repeats > 1 ? ` · pass ${repeat + 1}` : ''),
              surface,
              { [entry.name]: arm },
            ),
          );
        }
      }
      // Leave the switch on its shipping arm so a later scene cannot inherit
      // whichever arm happened to be photographed last.
      apply(sim, entry.defaultArm);
    }

    return {
      switchName: entry.name,
      scope: entry.scope,
      summary: entry.summary,
      defaultArm: entry.defaultArm,
      shots,
      scenes,
      tierStamp: formatRenderTierStamp(readTier(surface)),
    };
  };

  return {
    ready: true,
    tier: readTier,
    switches: abSwitchSummaries,
    setSwitch: (name, arm) => {
      const entry = findAbSwitch(name);
      entry.apply?.(sim, arm);
    },
    stage,
    shot: takeShot,
    captureAb,
    compose: async (frames, options) => {
      const sheetFrames: SheetFrame[] = [];
      for (const frame of frames) {
        sheetFrames.push({
          image: await dataUrlToCanvas(frame.dataUrl),
          label: frame.label,
        });
      }
      const sheet = buildContactSheet(sheetFrames, {
        columns: options.columns,
        cellWidth: options.cellWidth ?? 640,
        title: options.title,
        subtitle: options.subtitle,
      });
      return sheet.toDataURL('image/png');
    },
    diff: async (first, second) => {
      const [a, b] = await Promise.all([
        dataUrlToCanvas(first).then(imageData),
        dataUrlToCanvas(second).then(imageData),
      ]);
      if (a.length !== b.length) {
        throw new Error('cannot diff frames of different sizes');
      }
      let differing = 0;
      let maxChannelDelta = 0;
      let sum = 0;
      let signedLuma = 0;
      for (let index = 0; index < a.length; index += 4) {
        const delta = Math.max(
          Math.abs(a[index] - b[index]),
          Math.abs(a[index + 1] - b[index + 1]),
          Math.abs(a[index + 2] - b[index + 2]),
        );
        if (delta > 0) differing++;
        if (delta > maxChannelDelta) maxChannelDelta = delta;
        sum += delta;
        // Rec.709 luma on the encoded values. Not a physical luminance — these
        // are display-referred codes, which is the space the question "is this
        // two levels brighter on Ash's panel" is actually asked in.
        signedLuma +=
          0.2126 * (b[index] - a[index]) +
          0.7152 * (b[index + 1] - a[index + 1]) +
          0.0722 * (b[index + 2] - a[index + 2]);
      }
      const pixels = a.length / 4;
      return {
        pixels,
        differing,
        differingPercent: Number(((100 * differing) / pixels).toFixed(3)),
        maxChannelDelta,
        meanChannelDelta: Number((sum / pixels).toFixed(4)),
        meanSignedLuma: Number((signedLuma / pixels).toFixed(4)),
      };
    },
    diffImage: async (first, second, gain = 8) => {
      const [a, b] = await Promise.all([
        dataUrlToCanvas(first),
        dataUrlToCanvas(second),
      ]);
      const [ad, bd] = [imageData(a), imageData(b)];
      const out = document.createElement('canvas');
      out.width = a.width;
      out.height = a.height;
      const context = out.getContext('2d')!;
      const image = context.createImageData(out.width, out.height);
      for (let index = 0; index < ad.length; index += 4) {
        // Per-channel absolute difference, gained and clamped. Not a signed
        // or false-coloured map: "how much did this pixel move" is the only
        // question a look A/B asks of a difference, and a grey-on-black
        // magnitude answers it without inviting the reader to decode a key.
        for (let channel = 0; channel < 3; channel++) {
          const delta = Math.abs(ad[index + channel] - bd[index + channel]);
          image.data[index + channel] = Math.min(255, delta * gain);
        }
        image.data[index + 3] = 255;
      }
      context.putImageData(image, 0, 0);
      return out.toDataURL('image/png');
    },
    publish: async (name, dataUrl) => {
      const blob = await toBlob(await dataUrlToCanvas(dataUrl), 'image/png');
      return post(name, blob);
    },
    publishText: (name, text) => postText(name, text, 'text/plain'),
  };
}
