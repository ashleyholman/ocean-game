/**
 * The render tier a captured frame was actually taken at — and the assertion
 * that it is the tier that was asked for.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every look decision in this project is settled by Ash's eye on an image, and
 * an image is only evidence if it came out of the renderer being judged. Two
 * silent substitutions have already cost a round (`OCEAN_LOOK_ROUND_HANDOVER`
 * §6):
 *
 *   1. A viewport narrower than the desktop threshold selects
 *      `OCEAN_QUALITY_MOBILE` during bootstrap — three detail octaves instead
 *      of five, a 160x160 ring grid instead of 288x288. The browser pane is
 *      854 px wide and trips it every time. So does a `--window-size=1280,720`
 *      headless Chrome, whose content area is only 633 px tall.
 *   2. The adaptive-resolution walk moves the pixel ratio on its own schedule,
 *      so two frames of one A/B can be drawn at different framebuffer sizes.
 *
 * Neither announces itself. Both produce a perfectly plausible picture of a
 * renderer nobody asked about. The contract here is that a capture states the
 * tier it wants, the running app reports the tier it got, and a mismatch is an
 * ERROR rather than a caption — `assertRenderTier` throws, and no image is
 * written.
 *
 * The module is deliberately free of browser and three.js types: the facts
 * arrive as plain numbers gathered by the caller, so the comparison is unit
 * testable without a GPU.
 */

import { resolveRuntimeQuality } from '../runtime/RuntimeQuality';

export type QualityTier = 'desktop' | 'mobile';

/**
 * What a capture asked for. Every field is checked; none of it is advisory.
 *
 * `switches` names the A/B arms the caller believes are set — the switch's own
 * registry name mapped to the arm value. A capture that thinks it is
 * photographing the temporal-resolve arm and is not must fail like any other
 * tier mismatch, because "which arm is this" is the whole point of the frame.
 */
export interface RenderTierRequest {
  tier: QualityTier;
  cssWidth: number;
  cssHeight: number;
  pixelRatio: number;
  switches?: Readonly<Record<string, string>>;
}

/** What the renderer actually did, read back off the live app. */
export interface RenderTierFacts {
  /** The tier the runtime selected at bootstrap. */
  tier: QualityTier;
  /** `DETAIL_OCTAVES` as the ocean's compiled material currently defines it. */
  detailOctaves: number;
  oceanRings: number;
  oceanSectors: number;
  cssWidth: number;
  cssHeight: number;
  /** `renderer.getPixelRatio()`, which is what actually sizes the framebuffer. */
  pixelRatio: number;
  backingWidth: number;
  backingHeight: number;
  devicePixelRatio: number;
  /**
   * Whether the adaptive-resolution walk is unable to move the pixel ratio.
   * True when `?fixedDpr=` is set — `BrowserFrameDriver` skips the policy
   * entirely in that case — and separately guaranteed while the animation
   * loop is stopped, because the policy only runs from a frame callback.
   */
  adaptiveResolutionPinned: boolean;
  /** Whether the frame driver's rAF loop has been detached for the capture. */
  animationLoopStopped: boolean;
  preserveDrawingBuffer: boolean;
  /** Live read-back of every registered A/B switch, by registry name. */
  switches: Readonly<Record<string, string>>;
}

/** The geometry a tier is contractually obliged to draw at. */
export function tierGeometry(tier: QualityTier): {
  detailOctaves: number;
  rings: number;
  sectors: number;
} {
  const quality = resolveRuntimeQuality(tier === 'mobile');
  return {
    detailOctaves: quality.ocean.detailOctaves,
    rings: quality.ocean.rings,
    sectors: quality.ocean.sectors,
  };
}

/** Backing-store size three.js will produce for a CSS size and pixel ratio. */
export function expectedBackingStore(
  cssWidth: number,
  cssHeight: number,
  pixelRatio: number,
): { width: number; height: number } {
  return {
    width: Math.floor(cssWidth * pixelRatio),
    height: Math.floor(cssHeight * pixelRatio),
  };
}

/**
 * Every way the delivered frame differs from the requested one, in plain
 * English. An empty array is the only thing that makes a capture publishable.
 */
export function renderTierFaults(
  request: RenderTierRequest,
  facts: RenderTierFacts,
): string[] {
  const faults: string[] = [];

  if (facts.tier !== request.tier) {
    faults.push(
      `tier: asked for ${request.tier}, rendered ${facts.tier}` +
        (facts.tier === 'mobile'
          ? ' — a viewport under 640x1024 selects the mobile preset at bootstrap;' +
            ' pass ?quality=desktop'
          : ''),
    );
  }

  // The label and the geometry are checked separately on purpose. A tier that
  // SAYS desktop while the ocean compiled three octaves is the exact failure
  // the label alone cannot catch, and the runtime profile probe can lower the
  // octave count under a correct tier.
  const geometry = tierGeometry(request.tier);
  if (facts.detailOctaves !== geometry.detailOctaves) {
    faults.push(
      `detail octaves: ${request.tier} draws ${geometry.detailOctaves}, ` +
        `the compiled ocean has ${facts.detailOctaves}`,
    );
  }
  if (facts.oceanRings !== geometry.rings || facts.oceanSectors !== geometry.sectors) {
    faults.push(
      `ocean grid: ${request.tier} is ${geometry.rings}x${geometry.sectors}, ` +
        `built ${facts.oceanRings}x${facts.oceanSectors}`,
    );
  }

  if (facts.cssWidth !== request.cssWidth || facts.cssHeight !== request.cssHeight) {
    faults.push(
      `viewport: asked for ${request.cssWidth}x${request.cssHeight} CSS px, ` +
        `rendered ${facts.cssWidth}x${facts.cssHeight}`,
    );
  }
  if (Math.abs(facts.pixelRatio - request.pixelRatio) > 1e-6) {
    faults.push(
      `pixel ratio: asked for ${request.pixelRatio}, rendered ${facts.pixelRatio}`,
    );
  }

  const backing = expectedBackingStore(
    request.cssWidth,
    request.cssHeight,
    request.pixelRatio,
  );
  if (
    facts.backingWidth !== backing.width ||
    facts.backingHeight !== backing.height
  ) {
    faults.push(
      `backing store: expected ${backing.width}x${backing.height}, ` +
        `got ${facts.backingWidth}x${facts.backingHeight}`,
    );
  }

  if (!facts.adaptiveResolutionPinned && !facts.animationLoopStopped) {
    faults.push(
      'adaptive resolution is live: the walk can move the pixel ratio between ' +
        'two frames of one comparison — pass ?fixedDpr=, or stop the loop',
    );
  }

  for (const [name, wanted] of Object.entries(request.switches ?? {})) {
    const actual = facts.switches[name];
    if (actual === undefined) {
      faults.push(`switch ${name}: requested ${wanted}, but nothing reports it`);
    } else if (actual !== wanted) {
      faults.push(`switch ${name}: requested ${wanted}, live value is ${actual}`);
    }
  }

  return faults;
}

/** Throw unless the delivered frame is the requested one, in every respect. */
export function assertRenderTier(
  request: RenderTierRequest,
  facts: RenderTierFacts,
): void {
  const faults = renderTierFaults(request, facts);
  if (faults.length === 0) return;
  throw new Error(
    `capture tier mismatch — the frame is not of the renderer that was asked ` +
      `for:\n  - ${faults.join('\n  - ')}`,
  );
}

/**
 * One line of provenance to burn into the sheet. Long enough that a picture
 * found on disk in six months still says which renderer made it.
 */
export function formatRenderTierStamp(facts: RenderTierFacts): string {
  const switches = Object.entries(facts.switches)
    .map(([name, value]) => `${name}=${value}`)
    .join(' ');
  return (
    `${facts.tier} · ${facts.detailOctaves} octaves · ` +
    `${facts.oceanRings}x${facts.oceanSectors} rings · ` +
    `${facts.cssWidth}x${facts.cssHeight} @${facts.pixelRatio}x ` +
    `(${facts.backingWidth}x${facts.backingHeight})` +
    (switches ? ` · ${switches}` : '')
  );
}
