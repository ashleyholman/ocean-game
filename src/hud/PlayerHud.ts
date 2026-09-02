/**
 * The player-facing interface shell.
 *
 * Same shape as the developer shell — a pill in the bottom-left corner, one
 * window, one panel visible at a time, `\` to put every scrap of interface
 * away for a clean look at the sea — because that shape works and Ash's hands
 * already know it. What differs is what it contains: five short pages instead
 * of eight instrument panels, and a layout that becomes a bottom sheet on a
 * phone.
 *
 * Panels are still imported only when their tab is first opened, and switching
 * tabs hides rather than destroys, so a page keeps its state (and its canvas)
 * across visits.
 */

import { ensureHudStyle } from './hudStyle';
import { createInterfaceSwitchButton } from './interfaceSwitch';

export interface HudPanel {
  readonly element: HTMLElement;
  /** Called once per rendered frame while this page is selected and visible. */
  update?(dtSeconds: number): void;
  dispose(): void;
}

export interface HudPanelEntry {
  id: string;
  label: string;
  /** Dynamic import, so a page's code is absent until it is selected. */
  load: () => Promise<HudPanel>;
}

/**
 * Switching between the outside view and being aboard.
 *
 * The one control a player reaches for constantly, so it is not a page: it
 * sits over the picture in its own corner and is only ever one tap away. It
 * still belongs to the shell, because `\` must take it away with everything
 * else for a clean frame.
 */
export interface HudViewSwitcher {
  modeName(): string;
  setMode(mode: 'cinematic' | 'embodied'): void;
}

export class PlayerHud {
  private readonly launcher: HTMLButtonElement;
  private readonly panel: HTMLElement;
  private readonly body: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly tabs = new Map<string, HTMLButtonElement>();
  private readonly pages = new Map<string, HudPanel>();
  private readonly pageLoads = new Map<string, Promise<HudPanel>>();
  private selectedId: string | undefined;
  private panelOpen = false;
  private chromeVisible = true;
  /** Invalidates a pending import when another tab wins the race. */
  private generation = 0;
  private readonly onKey: (event: KeyboardEvent) => void;
  private view: HudViewSwitcher | undefined;

  private readonly viewButtons: Array<{
    button: HTMLButtonElement;
    mode: 'cinematic' | 'embodied';
  }> = [];
  private readonly viewBar: HTMLElement | undefined;

  constructor(
    private readonly entries: readonly HudPanelEntry[],
    view?: HudViewSwitcher,
  ) {
    ensureHudStyle();

    if (view) {
      this.viewBar = document.createElement('div');
      this.viewBar.className = 'hud-view';
      this.viewBar.setAttribute('role', 'group');
      this.viewBar.setAttribute('aria-label', 'View');
      for (const [mode, label] of [
        ['cinematic', 'Outside'],
        ['embodied', 'Aboard'],
      ] as const) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.setAttribute('aria-pressed', String(view.modeName() === mode));
        button.addEventListener('click', () => {
          view.setMode(mode);
          this.syncView(view);
          button.blur();
        });
        this.viewBar.appendChild(button);
        this.viewButtons.push({ button, mode });
      }
      document.body.appendChild(this.viewBar);
      this.view = view;
    }

    this.launcher = document.createElement('button');
    this.launcher.type = 'button';
    this.launcher.className = 'hud-launch';
    this.launcher.innerHTML = '<span class="hud-mark"></span><span>Controls</span>';
    this.launcher.title = 'Show the controls (\\ hides all interface)';
    this.launcher.setAttribute('aria-expanded', 'false');
    this.launcher.addEventListener('click', () => {
      if (this.panelOpen) this.closePanel();
      else void this.openPanel();
    });

    this.panel = document.createElement('section');
    this.panel.className = 'hud-panel';
    this.panel.id = 'player-controls';
    this.panel.hidden = true;
    this.panel.setAttribute('aria-label', 'Controls');
    this.launcher.setAttribute('aria-controls', this.panel.id);

    const head = document.createElement('header');
    head.className = 'hud-head';
    const heading = document.createElement('h2');
    heading.textContent = 'Drift';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'hud-close';
    close.textContent = '×';
    close.title = 'Close';
    close.setAttribute('aria-label', 'Close the controls');
    close.addEventListener('click', () => this.closePanel());
    // The way to the instruments, one click away and always in the same place.
    const toDeveloper = createInterfaceSwitchButton('developer', 'hud-switch-ui');
    const headActions = document.createElement('div');
    headActions.className = 'hud-head-actions';
    headActions.append(toDeveloper, close);
    head.append(heading, headActions);

    const tabList = document.createElement('div');
    tabList.className = 'hud-tabs';
    tabList.setAttribute('role', 'tablist');
    tabList.setAttribute('aria-label', 'Control pages');
    for (const entry of entries) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'hud-tab';
      tab.textContent = entry.label;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', 'false');
      tab.addEventListener('click', () => void this.select(entry.id));
      this.tabs.set(entry.id, tab);
      tabList.appendChild(tab);
    }

    this.body = document.createElement('div');
    this.body.className = 'hud-body';
    this.status = document.createElement('div');
    this.status.className = 'hud-status';
    this.status.textContent = 'Loading…';
    this.status.hidden = true;
    this.body.appendChild(this.status);
    this.panel.append(head, tabList, this.body);
    document.body.append(this.launcher, this.panel);

    this.onKey = (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      if (event.key === 'Escape' && this.panelOpen) {
        event.preventDefault();
        this.closePanel();
        this.launcher.focus();
        return;
      }
      if (event.key !== '\\') return;
      event.preventDefault();
      this.setChromeVisible(!this.chromeVisible);
    };
    window.addEventListener('keydown', this.onKey);
  }

  get chromeShown(): boolean {
    return this.chromeVisible;
  }

  /** Open the panel on a named page. Unknown ids are ignored. */
  async open(id: string): Promise<void> {
    await this.select(id);
  }

  update(dtSeconds: number): void {
    // The view switcher is outside the panel, so it keeps itself honest even
    // while the panel is shut — `V` and a double-tap move the same state.
    if (this.view && this.chromeVisible) this.syncView(this.view);
    if (!this.chromeVisible || !this.panelOpen || !this.selectedId) return;
    try {
      this.pages.get(this.selectedId)?.update?.(dtSeconds);
    } catch (error) {
      console.error(`[hud] ${this.selectedId} page update failed`, error);
    }
  }

  /** Hide or restore every scrap of interface for a clean view of the sea. */
  setChromeVisible(visible: boolean): void {
    this.chromeVisible = visible;
    this.syncVisibility();
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    for (const page of this.pages.values()) page.dispose();
    this.pages.clear();
    this.pageLoads.clear();
    this.launcher.remove();
    this.panel.remove();
    this.viewBar?.remove();
  }

  private syncView(view: HudViewSwitcher): void {
    const mode = view.modeName() === 'embodied' ? 'embodied' : 'cinematic';
    for (const entry of this.viewButtons) {
      const pressed = String(entry.mode === mode);
      if (entry.button.getAttribute('aria-pressed') !== pressed) {
        entry.button.setAttribute('aria-pressed', pressed);
      }
    }
  }

  private async openPanel(): Promise<void> {
    this.panelOpen = true;
    this.syncVisibility();
    const id = this.selectedId ?? this.entries[0]?.id;
    if (id) await this.select(id);
  }

  private closePanel(): void {
    this.panelOpen = false;
    this.generation += 1;
    this.syncVisibility();
  }

  private async select(id: string): Promise<void> {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry) return;

    const changed = this.selectedId !== id;
    this.panelOpen = true;
    this.selectedId = id;
    const generation = ++this.generation;
    this.syncVisibility();

    let page = this.pages.get(id);
    if (!page) {
      this.status.hidden = false;
      this.status.textContent = 'Loading…';
      try {
        page = await this.load(entry);
      } catch (error) {
        if (generation === this.generation) {
          this.status.hidden = false;
          this.status.textContent = `${entry.label} could not be opened.`;
        }
        console.error(`[hud] ${id} page failed to load`, error);
        return;
      }
    }
    // Another tab, or a close, may have happened during the import.
    if (
      generation !== this.generation ||
      this.selectedId !== id ||
      !this.panelOpen
    ) {
      return;
    }
    this.syncVisibility();
    if (changed) this.body.scrollTop = 0;
  }

  private load(entry: HudPanelEntry): Promise<HudPanel> {
    const pending = this.pageLoads.get(entry.id);
    if (pending) return pending;
    const load = entry
      .load()
      .then((page) => {
        this.pages.set(entry.id, page);
        page.element.hidden = true;
        page.element.setAttribute('role', 'tabpanel');
        this.body.appendChild(page.element);
        this.pageLoads.delete(entry.id);
        return page;
      })
      .catch((error: unknown) => {
        this.pageLoads.delete(entry.id);
        throw error;
      });
    this.pageLoads.set(entry.id, load);
    return load;
  }

  /**
   * One place decides what is on screen.
   *
   * The launcher stands down while the bottom sheet is up on a narrow screen,
   * where the sheet would otherwise cover it; on a wide screen the pill stays
   * put and lights up instead. Both are expressed here rather than in two
   * event handlers that can disagree.
   */
  private syncVisibility(): void {
    const panelVisible = this.chromeVisible && this.panelOpen;
    this.panel.hidden = !panelVisible;
    if (this.viewBar) this.viewBar.hidden = !this.chromeVisible;
    this.launcher.hidden = !this.chromeVisible || (panelVisible && isNarrow());
    this.launcher.setAttribute('aria-expanded', String(panelVisible));

    for (const [id, tab] of this.tabs) {
      tab.setAttribute('aria-selected', String(id === this.selectedId));
    }
    const selected = this.selectedId
      ? this.pages.get(this.selectedId)
      : undefined;
    for (const [id, page] of this.pages) {
      page.element.hidden = !panelVisible || id !== this.selectedId;
    }
    this.status.hidden = !panelVisible || selected !== undefined;
  }
}

function isNarrow(): boolean {
  return window.matchMedia('(max-width: 620px)').matches;
}
