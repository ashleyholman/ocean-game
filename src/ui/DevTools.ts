/**
 * The developer-tools shell.
 *
 * Every ordinary tool lives in one left-hand window. The window owns the
 * position, scrolling and visibility; panels only provide their controls.
 * Switching tabs hides rather than destroys a panel, so work-in-progress state
 * survives while guaranteeing that two diagnostic windows never stack.
 */

export interface DevPanel {
  /** Root element. The shell parents, shows and hides it. */
  readonly element: HTMLElement;
  /** Called once per rendered frame while the panel is selected and visible. */
  update?(dtSeconds: number): void;
  dispose(): void;
}

export interface DevPanelEntry {
  id: string;
  label: string;
  hint: string;
  /** Dynamic import, so the panel's code is absent until it is selected. */
  load: () => Promise<DevPanel>;
  /** Tools with their own render loop navigate instead of mounting. */
  navigateTo?: string;
}

import { createInterfaceSwitchButton } from '../hud/interfaceSwitch';

const STYLE = `
.devtools-launch {
  position: fixed; left: 12px; bottom: 12px; z-index: 60;
  display: flex; align-items: center; gap: 7px;
  min-height: 30px; padding: 7px 11px; border-radius: 6px;
  background: rgba(8, 14, 22, 0.60); color: #b9cede;
  border: 1px solid rgba(255, 255, 255, 0.14);
  font: 500 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: 0.07em; text-transform: uppercase;
  cursor: pointer; backdrop-filter: blur(7px);
  transition: background 140ms ease, color 140ms ease, border-color 140ms ease;
}
.devtools-launch:hover,
.devtools-launch:focus-visible { background: rgba(14, 24, 36, 0.88); color: #e6f0f8; }
.devtools-launch[hidden] { display: none; }
.devtools-launch .dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: #5c8fb8; box-shadow: 0 0 6px #5c8fb8;
}
.devtools-launch.is-open {
  color: #eaf6ef; border-color: rgba(127, 208, 160, 0.32);
}
.devtools-launch.is-open .dot { background: #7fd0a0; box-shadow: 0 0 6px #7fd0a0; }

.devtools-window {
  position: fixed; left: 12px; top: 12px; bottom: 54px; z-index: 62;
  display: flex; flex-direction: column;
  width: min(404px, calc(100vw - 24px));
  overflow: hidden; border-radius: 8px;
  background: rgba(8, 14, 22, 0.92); color: #cfd8e3;
  border: 1px solid rgba(255, 255, 255, 0.14);
  font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
  backdrop-filter: blur(10px);
  box-shadow: 0 10px 34px rgba(0, 0, 0, 0.48);
}
.devtools-window[hidden] { display: none; }
.devtools-header {
  flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between;
  min-height: 38px; padding: 0 7px 0 13px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.09);
}
.devtools-title {
  margin: 0; color: #8da7bd; font-size: 10px; font-weight: 600;
  letter-spacing: 0.12em; text-transform: uppercase;
}
.devtools-head-actions { display: flex; align-items: center; gap: 6px; }
.devtools-switch-ui {
  min-height: 24px; padding: 0 9px; border-radius: 999px;
  background: rgba(255, 255, 255, 0.05); color: #91a6b8;
  border: 1px solid rgba(255, 255, 255, 0.12); cursor: pointer;
  font: 600 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: 0.10em; text-transform: uppercase;
}
.devtools-switch-ui:hover, .devtools-switch-ui:focus-visible {
  background: rgba(120, 175, 220, 0.20); color: #edf5fb;
}

.devtools-close {
  display: grid; place-items: center; width: 27px; height: 27px; padding: 0;
  border: 1px solid transparent; border-radius: 5px;
  background: transparent; color: #91a6b8; cursor: pointer;
  font: 400 19px/1 ui-sans-serif, system-ui, sans-serif;
}
.devtools-close:hover,
.devtools-close:focus-visible {
  background: rgba(255, 255, 255, 0.08); color: #edf5fb;
  border-color: rgba(255, 255, 255, 0.10);
}
.devtools-tabs {
  flex: 0 0 auto; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px;
  padding: 7px 8px 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.09);
}
.devtools-tab {
  min-width: 0; padding: 5px 6px; border-radius: 5px;
  background: rgba(255, 255, 255, 0.035); color: #9eb2c3;
  border: 1px solid transparent; cursor: pointer; font: inherit;
  white-space: nowrap;
}
.devtools-tab:hover,
.devtools-tab:focus-visible { background: rgba(120, 175, 220, 0.14); color: #e0ebf4; }
.devtools-tab[aria-selected='true'] {
  background: rgba(111, 158, 196, 0.19); color: #edf6fc;
  border-color: rgba(122, 178, 222, 0.35);
}
.devtools-tab.is-navigation::after { content: ' ↗'; color: #718da4; }
.devtools-content {
  flex: 1 1 auto; min-height: 0; overflow-y: auto;
  overscroll-behavior: contain;
}
.devtools-status {
  padding: 18px 14px; color: #71879a; font-size: 10px;
  letter-spacing: 0.04em;
}
.devtools-content > .devpanel,
.devtools-content > .debug {
  position: static !important; width: 100%; max-width: none; max-height: none;
  overflow: visible; padding: 12px 14px 16px; border: 0; border-radius: 0;
  background: transparent; box-shadow: none; backdrop-filter: none;
}
.devtools-content > .devpanel[hidden],
.devtools-content > .debug[hidden] { display: none; }

@media (max-height: 480px) {
  .devtools-window { top: 8px; bottom: 48px; }
  .devtools-launch { left: 8px; bottom: 8px; }
}
@media (max-width: 360px) {
  .devtools-tabs { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
`;

export class DevTools {
  private readonly launcher: HTMLButtonElement;
  private readonly windowElement: HTMLElement;
  private readonly content: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly entries: DevPanelEntry[];
  private readonly panels = new Map<string, DevPanel>();
  private readonly panelLoads = new Map<string, Promise<DevPanel>>();
  private readonly tabs = new Map<string, HTMLButtonElement>();
  private selectedId: string | undefined;
  private windowOpen = false;
  private chromeVisible = true;
  /** Invalidates a pending dynamic import when another tab wins the race. */
  private selectionGeneration = 0;
  private readonly onKey: (event: KeyboardEvent) => void;

  constructor(entries: DevPanelEntry[]) {
    this.entries = entries;

    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    this.launcher = document.createElement('button');
    this.launcher.className = 'devtools-launch';
    this.launcher.type = 'button';
    this.launcher.innerHTML = '<span class="dot"></span><span>Debug</span>';
    this.launcher.title = 'Open developer tools (\\ hides all interface chrome)';
    this.launcher.setAttribute('aria-expanded', 'false');
    this.launcher.addEventListener('click', () => {
      if (this.windowOpen) this.closeWindow();
      else void this.openWindow();
    });

    this.windowElement = document.createElement('section');
    this.windowElement.className = 'devtools-window';
    this.windowElement.id = 'developer-tools-window';
    this.windowElement.hidden = true;
    this.windowElement.setAttribute('aria-label', 'Developer tools');
    this.launcher.setAttribute('aria-controls', this.windowElement.id);

    const header = document.createElement('header');
    header.className = 'devtools-header';
    const heading = document.createElement('h2');
    heading.className = 'devtools-title';
    heading.textContent = 'Debug tools';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'devtools-close';
    close.textContent = '×';
    close.title = 'Close debug tools';
    close.setAttribute('aria-label', 'Close debug tools');
    close.addEventListener('click', () => this.closeWindow());
    // The way back to what a visitor sees, one click away and in the same
    // place its counterpart sits on the player interface.
    const actions = document.createElement('div');
    actions.className = 'devtools-head-actions';
    actions.append(
      createInterfaceSwitchButton('player', 'devtools-switch-ui'),
      close,
    );
    header.append(heading, actions);

    const tabList = document.createElement('div');
    tabList.className = 'devtools-tabs';
    tabList.setAttribute('role', 'tablist');
    tabList.setAttribute('aria-label', 'Debug tool panels');
    for (const entry of entries) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'devtools-tab';
      if (entry.navigateTo) tab.classList.add('is-navigation');
      tab.textContent = shortLabel(entry);
      tab.title = `${entry.label} — ${entry.hint}`;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', 'false');
      tab.addEventListener('click', () => {
        if (entry.navigateTo) {
          window.location.search = entry.navigateTo;
          return;
        }
        void this.open(entry.id);
      });
      this.tabs.set(entry.id, tab);
      tabList.appendChild(tab);
    }

    this.content = document.createElement('div');
    this.content.className = 'devtools-content';
    this.status = document.createElement('div');
    this.status.className = 'devtools-status';
    this.status.textContent = 'Choose a tool';
    this.content.appendChild(this.status);
    this.windowElement.append(header, tabList, this.content);
    document.body.append(this.launcher, this.windowElement);

    this.onKey = (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      if (event.key === 'Escape' && this.windowOpen) {
        event.preventDefault();
        this.closeWindow();
        this.launcher.focus();
        return;
      }
      if (event.key !== '\\') return;
      event.preventDefault();
      this.setChromeVisible(!this.chromeVisible);
    };
    window.addEventListener('keydown', this.onKey);
  }

  /** The sole panel currently selected in the shared window. */
  get openPanels(): readonly string[] {
    return this.windowOpen && this.selectedId ? [this.selectedId] : [];
  }

  private async openWindow(): Promise<void> {
    this.windowOpen = true;
    this.syncWindowVisibility();
    const firstPanel = this.entries.find((entry) => !entry.navigateTo);
    const id = this.selectedId ?? firstPanel?.id;
    if (id) await this.open(id);
  }

  private closeWindow(): void {
    this.windowOpen = false;
    this.selectionGeneration += 1;
    this.syncWindowVisibility();
    this.hidePanels();
  }

  /** Select a tab and show it as the only panel in the shared window. */
  async open(id: string): Promise<void> {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry || entry.navigateTo) return;

    this.windowOpen = true;
    this.selectedId = id;
    const generation = ++this.selectionGeneration;
    this.syncSelection();
    this.syncWindowVisibility();
    this.hidePanels();

    let panel = this.panels.get(id);
    if (!panel) {
      this.status.hidden = false;
      this.status.textContent = `Loading ${entry.label}…`;
      try {
        panel = await this.loadPanel(entry);
      } catch (error) {
        if (generation === this.selectionGeneration) {
          this.status.hidden = false;
          this.status.textContent = `${entry.label} could not be opened.`;
        }
        console.error(`[devtools] ${id} panel failed to load`, error);
        return;
      }
    }

    // A different tab (or close action) may have happened during the import.
    if (
      generation !== this.selectionGeneration ||
      this.selectedId !== id ||
      !this.windowOpen
    ) return;

    this.status.hidden = true;
    panel.element.hidden = !this.chromeVisible;
    this.content.scrollTop = 0;
  }

  /** Compatibility alias: a tab click always selects; it never stacks. */
  async toggle(id: string): Promise<void> {
    await this.open(id);
  }

  /** Close the window while keeping the selected panel and its state. */
  close(id: string): void {
    if (id !== this.selectedId) return;
    this.closeWindow();
  }

  /** Put the tools away for a clean frame. The launcher chip stays. */
  hideAll(): void {
    this.closeWindow();
  }

  /** Hide or restore all diagnostic chrome for a completely clean capture. */
  setChromeVisible(visible: boolean): void {
    this.chromeVisible = visible;
    this.launcher.hidden = !visible;
    this.syncWindowVisibility();
    if (!visible) this.hidePanels();
    else this.showSelectedPanel();
  }

  get chromeShown(): boolean {
    return this.chromeVisible;
  }

  update(dtSeconds: number): void {
    if (!this.chromeVisible || !this.windowOpen || !this.selectedId) return;
    try {
      this.panels.get(this.selectedId)?.update?.(dtSeconds);
    } catch (error) {
      console.error(`[devtools] ${this.selectedId} panel update failed`, error);
    }
  }

  private syncWindowVisibility(): void {
    const visible = this.chromeVisible && this.windowOpen;
    this.windowElement.hidden = !visible;
    this.launcher.classList.toggle('is-open', visible);
    this.launcher.setAttribute('aria-expanded', String(visible));
    if (visible) this.showSelectedPanel();
  }

  private syncSelection(): void {
    for (const [id, tab] of this.tabs) {
      tab.setAttribute('aria-selected', String(id === this.selectedId));
    }
  }

  private hidePanels(): void {
    for (const panel of this.panels.values()) panel.element.hidden = true;
  }

  private showSelectedPanel(): void {
    this.hidePanels();
    if (!this.selectedId) return;
    const panel = this.panels.get(this.selectedId);
    if (panel) {
      this.status.hidden = true;
      panel.element.hidden = false;
    }
  }

  /** Share one import when a tab is revisited before its first load finishes. */
  private loadPanel(entry: DevPanelEntry): Promise<DevPanel> {
    const pending = this.panelLoads.get(entry.id);
    if (pending) return pending;

    const load = entry.load().then((panel) => {
      this.panels.set(entry.id, panel);
      panel.element.hidden = true;
      panel.element.setAttribute('role', 'tabpanel');
      this.content.appendChild(panel.element);
      this.panelLoads.delete(entry.id);
      return panel;
    }).catch((error: unknown) => {
      this.panelLoads.delete(entry.id);
      throw error;
    });
    this.panelLoads.set(entry.id, load);
    return load;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    for (const panel of this.panels.values()) panel.dispose();
    this.panels.clear();
    this.panelLoads.clear();
    this.launcher.remove();
    this.windowElement.remove();
  }
}

function shortLabel(entry: DevPanelEntry): string {
  const labels: Record<string, string> = {
    world: 'World',
    sailing: 'Sailing',
    camera: 'Camera',
    terrain: 'Terrain',
    deck: 'Deck',
    inspection: 'Inspect',
    ocean: 'Ocean',
    graphics: 'Graphics',
    buoyancy: 'Buoyancy',
  };
  return labels[entry.id] ?? entry.label;
}
