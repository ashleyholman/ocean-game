/**
 * What the player interface is made of, and what it is allowed to reach.
 *
 * The pages themselves build DOM and are checked by eye; this covers the two
 * things that are not visual — that a page's code is absent until its tab is
 * opened, and that each page receives its own narrow source object rather than
 * the runtime.
 */

import { describe, expect, it } from 'vitest';

import {
  createPlayerHudEntries,
  type PlayerHudPanelLoaders,
  type PlayerHudSources,
} from '../src/hud/playerPanels';
import { hintText } from '../src/ui/Hint';

function createFixture() {
  const calls: string[] = [];
  const received: Record<string, unknown> = {};
  const page = (name: string) => ({
    element: {} as HTMLElement,
    dispose: () => calls.push(`dispose.${name}`),
  });

  const loaders = {
    sailing: async () => {
      calls.push('import.sailing');
      return {
        createSailingPanel: (sources: unknown) => {
          received.sailing = sources;
          return page('sailing');
        },
      };
    },
    ocean: async () => {
      calls.push('import.ocean');
      return {
        createOceanPanel: (sources: unknown) => {
          received.ocean = sources;
          return page('ocean');
        },
      };
    },
    world: async () => {
      calls.push('import.world');
      return {
        createWorldPanel: (sources: unknown) => {
          received.world = sources;
          return page('world');
        },
      };
    },
    settings: async () => {
      calls.push('import.settings');
      return {
        createSettingsPanel: (cameras: unknown) => {
          received.settings = cameras;
          return page('settings');
        },
      };
    },
    performance: async () => {
      calls.push('import.performance');
      return {
        createPerfPanel: (sources: unknown) => {
          received.performance = sources;
          return page('performance');
        },
      };
    },
  } as unknown as PlayerHudPanelLoaders;

  const sailing = { controls: {}, crew: {}, read: () => ({}) };
  const ocean = { state: () => ({}), apply: () => undefined };
  const world = { world: {}, astronomy: {}, onTimeCommitted: () => undefined };
  const cameras = { identity: 'cameras' };
  const performance = { reading: () => ({}), nativePixelRatio: () => 2 };
  const sources = {
    sailing,
    ocean,
    world,
    cameras,
    performance,
  } as unknown as PlayerHudSources;

  return {
    calls,
    received,
    sources: { sailing, ocean, world, cameras, performance },
    entries: createPlayerHudEntries(sources, loaders),
  };
}

describe('the player HUD', () => {
  it('names its pages without importing any of them', () => {
    const fixture = createFixture();
    expect(fixture.entries.map(({ id }) => id)).toEqual([
      'world',
      'sailing',
      'ocean',
      'settings',
      'performance',
    ]);
    expect(fixture.entries.map(({ label }) => label)).toEqual([
      'World',
      'Sailing',
      'Ocean',
      'Settings',
      'Debug',
    ]);
    expect(fixture.calls).toEqual([]);
  });

  it('imports a page only when it is loaded, and hands it its own sources', async () => {
    const fixture = createFixture();

    await fixture.entries[1].load();
    expect(fixture.calls).toEqual(['import.sailing']);
    expect(fixture.received.sailing).toEqual(fixture.sources.sailing);

    await fixture.entries[3].load();
    expect(fixture.calls).toEqual(['import.sailing', 'import.settings']);
    // The settings page gets the camera system itself; the others never see it.
    expect(fixture.received.settings).toBe(fixture.sources.cameras);
    expect(fixture.received.ocean).toBeUndefined();
  });

  it('drops the sailing page when there is no rig to steer', () => {
    const fixture = createFixture();
    const entries = createPlayerHudEntries({
      ...(fixture.sources as unknown as PlayerHudSources),
      sailing: undefined,
    });
    expect(entries.map(({ id }) => id)).toEqual([
      'world',
      'ocean',
      'settings',
      'performance',
    ]);
  });
});

/**
 * The opening hint, and the raft-era control it kept advertising.
 *
 * `WindSystem`'s sail is not dead code — the diagnostic raft draws its canvas
 * from `sail`, and both the raft and the schooner viewer take their speed from
 * `targetDriftSpeedMps` — so none of it was deleted. What was retired is the
 * claim that the production schooner has it. Her rig is five sails on trim and
 * hoist; R reached nothing a player could see.
 */
describe('the opening hint', () => {
  it('offers the sail only on a vessel that has the drift sail', () => {
    expect(hintText(false, true)).toContain('R for the sail');
    expect(hintText(false, false)).not.toContain('sail');
    expect(hintText(true, true)).toContain('Tap the sail to raise it');
    expect(hintText(true, false)).not.toContain('sail');
  });

  it('keeps every other clause, and the sound clause last', () => {
    // Dropping a clause must not drop its neighbours or leave a stranded
    // separator, which is the ordinary way a conditional string goes wrong.
    const schooner = hintText(false, false);
    expect(schooner).toBe(
      'Drag to look  ·  Scroll to change scale  ·  V to change view  ·  ' +
        'Space to use  ·  M for sound',
    );
    expect(hintText(true, false)).toBe(
      'Drag to look  ·  Pinch to change scale  ·  Double-tap to change view',
    );
  });
});
