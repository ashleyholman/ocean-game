import { describe, expect, it } from 'vitest';

import { AB_SWITCHES, findAbSwitch } from '../src/debug/abSwitches';
import {
  assertRenderTier,
  expectedBackingStore,
  formatRenderTierStamp,
  renderTierFaults,
  tierGeometry,
  type RenderTierFacts,
  type RenderTierRequest,
} from '../src/render/renderTier';
import { resolveRuntimeOptions } from '../src/runtime/RuntimeOptions';
import { scenarioFaults } from '../tools/perf/suites.mjs';

/**
 * The capture contract's whole value is that a wrong frame FAILS rather than
 * arriving with a caption. These tests hold that: every field of the tier is
 * checked, and each one on its own is enough to reject a capture.
 */

const DESKTOP_FACTS: RenderTierFacts = {
  tier: 'desktop',
  detailOctaves: tierGeometry('desktop').detailOctaves,
  oceanRings: tierGeometry('desktop').rings,
  oceanSectors: tierGeometry('desktop').sectors,
  cssWidth: 1280,
  cssHeight: 720,
  pixelRatio: 2,
  backingWidth: 2560,
  backingHeight: 1440,
  devicePixelRatio: 1,
  adaptiveResolutionPinned: true,
  animationLoopStopped: true,
  preserveDrawingBuffer: true,
  switches: { oceanTaa: '0', legacyToneCurve: '0' },
};

const DESKTOP_REQUEST: RenderTierRequest = {
  tier: 'desktop',
  cssWidth: 1280,
  cssHeight: 720,
  pixelRatio: 2,
};

describe('render tier', () => {
  it('accepts a frame that is exactly what was asked for', () => {
    expect(renderTierFaults(DESKTOP_REQUEST, DESKTOP_FACTS)).toEqual([]);
    expect(() => assertRenderTier(DESKTOP_REQUEST, DESKTOP_FACTS)).not.toThrow();
  });

  it('travels with the capture: the stamp names the renderer that drew it', () => {
    const stamp = formatRenderTierStamp(DESKTOP_FACTS);
    expect(stamp).toContain('desktop');
    expect(stamp).toContain(`${tierGeometry('desktop').detailOctaves} octaves`);
    expect(stamp).toContain('288x288 rings');
    expect(stamp).toContain('1280x720 @2x');
    expect(stamp).toContain('2560x1440');
    // The A/B arms are provenance too: a frame that does not say which arm it
    // is cannot be filed next to its pair six months later.
    expect(stamp).toContain('oceanTaa=0');
  });

  it('rejects the mobile substitution a narrow viewport causes', () => {
    // The exact failure this round exists to close: the browser pane is 854 px
    // wide, and a --window-size=1280,720 headless Chrome has 633 px of content
    // height. Both select the mobile preset during bootstrap, silently.
    const mobile: RenderTierFacts = {
      ...DESKTOP_FACTS,
      tier: 'mobile',
      detailOctaves: tierGeometry('mobile').detailOctaves,
      oceanRings: tierGeometry('mobile').rings,
      oceanSectors: tierGeometry('mobile').sectors,
    };
    const faults = renderTierFaults(DESKTOP_REQUEST, mobile);
    expect(faults.join('\n')).toContain('asked for desktop, rendered mobile');
    expect(faults.join('\n')).toContain('?quality=desktop');
    expect(() => assertRenderTier(DESKTOP_REQUEST, mobile)).toThrow(
      /capture tier mismatch/,
    );
  });

  it('rejects a correct tier LABEL over the wrong geometry', () => {
    // The runtime profile probe can lower the octave count under a perfectly
    // correct tier. The label alone cannot see that; the geometry check can.
    const starved: RenderTierFacts = { ...DESKTOP_FACTS, detailOctaves: 3 };
    expect(renderTierFaults(DESKTOP_REQUEST, starved).join('\n')).toContain(
      'detail octaves: desktop draws 5, the compiled ocean has 3',
    );
    expect(() => assertRenderTier(DESKTOP_REQUEST, starved)).toThrow();
  });

  it('rejects the wrong size, ratio or backing store', () => {
    expect(
      renderTierFaults(DESKTOP_REQUEST, { ...DESKTOP_FACTS, cssHeight: 633 })
        .join('\n'),
    ).toContain('viewport: asked for 1280x720');
    expect(
      renderTierFaults(DESKTOP_REQUEST, {
        ...DESKTOP_FACTS,
        pixelRatio: 1,
        backingWidth: 1280,
        backingHeight: 720,
      }).join('\n'),
    ).toContain('pixel ratio: asked for 2, rendered 1');
    // A backing store that does not follow from the size and ratio means
    // something resized the framebuffer behind the capture's back.
    expect(
      renderTierFaults(DESKTOP_REQUEST, { ...DESKTOP_FACTS, backingWidth: 1920 })
        .join('\n'),
    ).toContain('backing store: expected 2560x1440, got 1920x1440');
    expect(expectedBackingStore(1280, 720, 2)).toEqual({ width: 2560, height: 1440 });
  });

  it('rejects a live adaptive-resolution walk under a running loop', () => {
    const walking: RenderTierFacts = {
      ...DESKTOP_FACTS,
      adaptiveResolutionPinned: false,
      animationLoopStopped: false,
    };
    expect(renderTierFaults(DESKTOP_REQUEST, walking).join('\n')).toContain(
      'adaptive resolution is live',
    );
    // Either guard alone is enough: a stopped loop cannot run the policy.
    expect(
      renderTierFaults(DESKTOP_REQUEST, {
        ...walking,
        animationLoopStopped: true,
      }),
    ).toEqual([]);
  });

  it('rejects a frame captioned with an arm it was not taken at', () => {
    const request: RenderTierRequest = {
      ...DESKTOP_REQUEST,
      switches: { oceanTaa: '1' },
    };
    expect(renderTierFaults(request, DESKTOP_FACTS).join('\n')).toContain(
      'switch oceanTaa: requested 1, live value is 0',
    );
    expect(
      renderTierFaults(
        { ...DESKTOP_REQUEST, switches: { notAThing: '1' } },
        DESKTOP_FACTS,
      ).join('\n'),
    ).toContain('but nothing reports it');
  });

  it('reports every fault at once, not just the first', () => {
    const wrong: RenderTierFacts = {
      ...DESKTOP_FACTS,
      tier: 'mobile',
      detailOctaves: 3,
      oceanRings: 160,
      oceanSectors: 160,
      cssHeight: 633,
    };
    expect(renderTierFaults(DESKTOP_REQUEST, wrong).length).toBeGreaterThanOrEqual(4);
  });
});

describe('the quality tier is stated, not inferred, when a capture asks', () => {
  const pane = {
    // The browser pane, to the pixel: this is the viewport that started it all.
    viewportWidth: 854,
    viewportHeight: 600,
    isTouch: false,
  };

  it('still infers mobile from a small viewport when nothing is stated', () => {
    expect(resolveRuntimeOptions(new URLSearchParams(), pane).isSmallScreen).toBe(true);
  });

  it('honours a stated tier in BOTH directions', () => {
    expect(
      resolveRuntimeOptions(new URLSearchParams('quality=desktop'), pane),
    ).toMatchObject({ isSmallScreen: false, forcedQualityTier: 'desktop' });
    // The half that did not exist: a tier you meant to test should not depend
    // on finding a small enough window.
    expect(
      resolveRuntimeOptions(new URLSearchParams('quality=mobile'), {
        viewportWidth: 2560,
        viewportHeight: 1440,
        isTouch: false,
      }),
    ).toMatchObject({ isSmallScreen: true, forcedQualityTier: 'mobile' });
  });

  it('throws on a misspelled tier rather than falling back to the guess', () => {
    expect(() =>
      resolveRuntimeOptions(new URLSearchParams('quality=Desktop'), pane),
    ).toThrow(/use desktop \| mobile/);
  });

  it('opens the capture session only on ?capture=1', () => {
    expect(
      resolveRuntimeOptions(new URLSearchParams(), pane).captureHostEnabled,
    ).toBe(false);
    expect(
      resolveRuntimeOptions(new URLSearchParams('capture=1'), pane)
        .captureHostEnabled,
    ).toBe(true);
  });
});

describe('the A/B switch registry', () => {
  it('gives every switch a readable value, not just a settable one', () => {
    // The discipline the registry exists to enforce: a sheet that can set an
    // arm but not read it back cannot detect the arm failing to take.
    for (const entry of AB_SWITCHES) {
      expect(typeof entry.read, entry.name).toBe('function');
      expect(entry.arms.length, entry.name).toBeGreaterThanOrEqual(2);
      expect(entry.arms, entry.name).toContain(entry.defaultArm);
      expect(entry.summary.length, entry.name).toBeGreaterThan(10);
    }
  });

  it('separates live switches from page-load ones', () => {
    // A `reload` switch changes shader source, which three's program cache is
    // not keyed on. Flipping one in place is a lie, so it must not carry an
    // `apply`, and it must carry the URL that selects its arm instead.
    for (const entry of AB_SWITCHES) {
      if (entry.scope === 'live') {
        expect(typeof entry.apply, entry.name).toBe('function');
      } else {
        expect(entry.apply, entry.name).toBeUndefined();
        expect(typeof entry.urlFor, entry.name).toBe('function');
      }
    }
    expect(findAbSwitch('shoulder').scope).toBe('reload');
    expect(findAbSwitch('shoulder').urlFor!('0.7')).toEqual({ shoulder: '0.7' });
    expect(findAbSwitch('legacyToneCurve').scope).toBe('live');
  });

  it('names an unknown switch instead of silently doing nothing', () => {
    expect(() => findAbSwitch('shouldar')).toThrow(/unknown A\/B switch/);
  });
});

describe('perf scenarios state what they will be measured in', () => {
  const stand = {
    id: 'night-production-cabin-aft-shadow-on',
    camera: {
      kind: 'stand',
      stand: 'Cabin',
      lookYawDeg: 180,
      lookPitchDeg: 0,
    },
    lamps: 'on',
    lampsShadow: true,
  } as const;
  const applied = {
    cameraMode: 'embodied',
    eye: { x: 0, y: 1, z: -6 },
    standResolved: { x: 0, z: -6 },
    lookYawDeg: 180,
    lookPitchDeg: 0,
    lamps: 'on',
    lampsShadow: true,
  };

  it('accepts a scenario that took', () => {
    expect(scenarioFaults(stand, applied)).toEqual([]);
  });

  it('rejects a refused stand, a wrong look and a wrong lamp policy', () => {
    expect(
      scenarioFaults(stand, { ...applied, standRefused: true }).join('\n'),
    ).toContain('the walker refused it');
    expect(
      scenarioFaults(stand, { ...applied, lookYawDeg: 0 }).join('\n'),
    ).toContain('lookYawDeg: asked for 180, got 0');
    expect(
      scenarioFaults(stand, { ...applied, lampsShadow: false }).join('\n'),
    ).toContain('lampsShadow: asked for true, live value is false');
    expect(
      scenarioFaults(stand, { ...applied, cameraMode: 'cinematic' }).join('\n'),
    ).toContain('needs the embodied camera');
    // An eye that drifted off its station is the difference between a cabin
    // frame and a frame of the inside of a bulkhead.
    expect(
      scenarioFaults(stand, { ...applied, eye: { x: 0, y: 1, z: -5 } }).join('\n'),
    ).toContain('from the station');
  });

  it('leaves a scenario that stated no lamp policy alone', () => {
    const orbit = {
      id: 'day-production-medium',
      camera: { kind: 'orbit', distanceM: 34, altitudeM: 9 },
      lamps: null,
      lampsShadow: null,
    } as const;
    expect(scenarioFaults(orbit, { cameraMode: 'cinematic' })).toEqual([]);
  });
});
