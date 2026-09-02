/**
 * The player interface's pages, and what each one is allowed to touch.
 *
 * The order is the developer shell's order — world first, then sailing — so
 * that opening either interface puts you in the same place. Every page names
 * its own narrow source object rather than being handed the runtime: the
 * sailing page can speak to the crew and cannot reach the ocean, the ocean
 * page can set a sea state and cannot reach the camera. That is the same
 * discipline `SimHandle` imposes on the diagnostic tools, for the same reason
 * — a small interface is only small if its authority is too.
 *
 * Page modules are imported when their tab is first opened, so opening the
 * game loads the shell and nothing else.
 */

import type { CameraSystem } from '../camera/CameraSystem';
import type { HudPanelEntry } from './PlayerHud';
import type { OceanPanelSources } from './panels/OceanPanel';
import type { PerfPanelSources } from './panels/PerfPanel';
import type { SailingPanelSources } from './panels/SailingPanel';
import type { WorldPanelSources } from './panels/WorldPanel';

export interface PlayerHudSources {
  world: WorldPanelSources;
  /** Absent on vessels with no rig and no crew — the raft. */
  sailing?: SailingPanelSources;
  ocean: OceanPanelSources;
  cameras: CameraSystem;
  performance: PerfPanelSources;
}

export interface PlayerHudPanelLoaders {
  world(): Promise<
    Pick<typeof import('./panels/WorldPanel'), 'createWorldPanel'>
  >;
  sailing(): Promise<
    Pick<typeof import('./panels/SailingPanel'), 'createSailingPanel'>
  >;
  ocean(): Promise<
    Pick<typeof import('./panels/OceanPanel'), 'createOceanPanel'>
  >;
  settings(): Promise<
    Pick<typeof import('./panels/SettingsPanel'), 'createSettingsPanel'>
  >;
  performance(): Promise<
    Pick<typeof import('./panels/PerfPanel'), 'createPerfPanel'>
  >;
}

const DEFAULT_LOADERS: PlayerHudPanelLoaders = {
  world: () => import('./panels/WorldPanel'),
  sailing: () => import('./panels/SailingPanel'),
  ocean: () => import('./panels/OceanPanel'),
  settings: () => import('./panels/SettingsPanel'),
  performance: () => import('./panels/PerfPanel'),
};

export function createPlayerHudEntries(
  sources: PlayerHudSources,
  loaders: PlayerHudPanelLoaders = DEFAULT_LOADERS,
): HudPanelEntry[] {
  const entries: HudPanelEntry[] = [
    {
      id: 'world',
      label: 'World',
      load: async () => {
        const { createWorldPanel } = await loaders.world();
        return createWorldPanel(sources.world);
      },
    },
  ];

  if (sources.sailing) {
    entries.push({
      id: 'sailing',
      label: 'Sailing',
      load: async () => {
        const { createSailingPanel } = await loaders.sailing();
        return createSailingPanel(sources.sailing!);
      },
    });
  }

  entries.push(
    {
      id: 'ocean',
      label: 'Ocean',
      load: async () => {
        const { createOceanPanel } = await loaders.ocean();
        return createOceanPanel(sources.ocean);
      },
    },
    {
      id: 'settings',
      label: 'Settings',
      load: async () => {
        const { createSettingsPanel } = await loaders.settings();
        return createSettingsPanel(sources.cameras);
      },
    },
    {
      id: 'performance',
      label: 'Debug',
      load: async () => {
        const { createPerfPanel } = await loaders.performance();
        return createPerfPanel(sources.performance);
      },
    },
  );

  return entries;
}
