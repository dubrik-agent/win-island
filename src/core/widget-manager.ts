import { api } from "./api";
import { h, icon } from "./dom";
import type { SettingsStore } from "./settings-store";
import { playUiSound } from "./sound";
import type { WidgetContext, WidgetDef, WidgetHooks, WidgetState } from "./widget-types";

interface Runtime {
  def: WidgetDef;
  root: HTMLElement;
  ctx: WidgetContext;
  hooks: WidgetHooks;
}

export interface WidgetManagerHooks {
  expand: (widgetId?: string) => void;
  collapse: () => void;
  requestResize: () => void;
  toast: (message: string) => void;
  chime: () => void;
  alarm: (item: { id: string; text: string; time?: string }) => void;
  /** The set of enabled widgets or their order changed; sync other windows. */
  onWidgetsChanged?: (enabled: string[], order: string[]) => void;
}

/**
 * Owns widget lifetime, the tab bar, the active widget and the compact
 * indicators inside the pill. Only enabled widgets are ever mounted, so idle
 * cost stays near zero.
 */
export class WidgetManager {
  private runtimes = new Map<string, Runtime>();
  private minis = new Map<string, HTMLElement>();
  private state: WidgetState = { enabled: [], active: "" };
  /** User-defined tab order; empty means "declaration order". */
  private order: string[] = [];
  private saveSoon = false;
  private miniVisible = true;
  private miniKey = "";

  constructor(
    private readonly defs: WidgetDef[],
    private readonly hostEl: HTMLElement,
    private readonly tabsEl: HTMLElement,
    private readonly pillMinis: HTMLElement,
    private readonly settings: SettingsStore,
    private readonly hooks: WidgetManagerHooks,
  ) {
    // Registered once: `renderTabs` replaces the buttons, not the container.
    this.tabsEl.addEventListener("keydown", (event) => this.onTabKey(event));
  }

  get activeId(): string {
    return this.state.active;
  }

  get definitions(): WidgetDef[] {
    return this.orderedDefs();
  }

  get enabledIds(): string[] {
    return [...this.state.enabled];
  }

  /** Tab order as widget ids (all known widgets, enabled or not). */
  get orderIds(): string[] {
    return this.orderedDefs().map((def) => def.id);
  }

  /**
   * Widgets in the user's order. Ids that are not in the saved order (new
   * widgets after an update) keep their declaration order at the end.
   */
  private orderedDefs(): WidgetDef[] {
    if (this.order.length === 0) return [...this.defs];
    const rank = new Map(this.order.map((id, index) => [id, index]));
    return [...this.defs].sort((a, b) => {
      const ra = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const rb = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      if (ra === rb) return this.defs.indexOf(a) - this.defs.indexOf(b);
      return ra - rb;
    });
  }

  async init(): Promise<void> {
    const saved = await api.readStore<WidgetState>("widgets");
    const enabled = new Set<string>();
    for (const def of this.defs) {
      if (def.defaultEnabled || def.alwaysEnabled) enabled.add(def.id);
    }
    if (saved?.enabled?.length) {
      for (const id of saved.enabled) {
        if (this.defs.some((d) => d.id === id)) enabled.add(id);
      }
    }
    for (const def of this.defs) {
      if (def.alwaysEnabled) enabled.add(def.id);
    }
    this.order = this.sanitizeOrder(saved?.order);
    const available = this.orderedDefs().filter((d) => enabled.has(d.id));
    const preferred = saved?.active && enabled.has(saved.active) ? saved.active : "";
    this.state = {
      enabled: available.map((d) => d.id),
      active: preferred || available[0]?.id || "",
    };
    this.rebuild();
    // The settings switch must take effect immediately, not on the next
    // widget update.
    this.miniVisible = this.settings.value.showMiniWidgets;
    this.settings.subscribe((s) => {
      if (s.showMiniWidgets !== this.miniVisible) {
        this.miniVisible = s.showMiniWidgets;
        this.renderMinis();
      }
    });
  }

  isEnabled(id: string): boolean {
    return this.state.enabled.includes(id);
  }

  private sanitizeOrder(ids?: string[]): string[] {
    if (!Array.isArray(ids)) return [];
    const known = new Set(this.defs.map((def) => def.id));
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of ids) {
      if (!known.has(id) || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }

  /** New tab order from the settings UI (drag & drop or arrow buttons). */
  reorder(ids: string[]): void {
    this.order = this.sanitizeOrder(ids);
    this.state.enabled = this.orderedDefs()
      .filter((def) => this.state.enabled.includes(def.id))
      .map((def) => def.id);
    this.rebuild();
    this.persist();
    this.hooks.onWidgetsChanged?.(this.enabledIds, this.orderIds);
  }

  /** Order coming from the standalone settings window. */
  setOrder(ids: string[]): void {
    const next = this.sanitizeOrder(ids);
    if (next.join("|") === this.order.join("|")) return;
    this.order = next;
    this.state.enabled = this.orderedDefs()
      .filter((def) => this.state.enabled.includes(def.id))
      .map((def) => def.id);
    this.rebuild();
  }

  toggleEnabled(id: string, on: boolean): void {
    const def = this.defs.find((d) => d.id === id);
    if (!def || def.alwaysEnabled) return;
    const set = new Set(this.state.enabled);
    if (on) set.add(id);
    else set.delete(id);
    if (set.size === 0) return;

    this.state.enabled = this.orderedDefs().filter((d) => set.has(d.id)).map((d) => d.id);
    this.rebuild();
    this.persist();
    this.hooks.onWidgetsChanged?.(this.enabledIds, this.orderIds);
  }

  /** Apply the enabled set coming from the settings window. */
  setEnabledIds(ids: string[]): void {
    const set = new Set(ids);
    for (const def of this.defs) {
      if (def.alwaysEnabled) set.add(def.id);
    }
    const next = this.orderedDefs().filter((d) => set.has(d.id)).map((d) => d.id);
    if (next.length === 0) return;
    if (
      next.length === this.state.enabled.length &&
      next.every((id, index) => id === this.state.enabled[index])
    ) {
      return;
    }
    this.state.enabled = next;
    this.rebuild();
  }

  setActive(id: string): void {
    if (!this.runtimes.has(id)) return;
    if (this.state.active === id) {
      this.hooks.requestResize();
      return;
    }
    // Only a real tab switch gets a click; restoring the tab after an expand
    // must stay silent.
    const s = this.settings.value;
    playUiSound("tab", s.uiSounds, s.uiSoundVolume);
    const prev = this.runtimes.get(this.state.active);
    prev?.hooks.onHide?.();
    prev?.root.classList.remove("active");

    this.state.active = id;
    const runtime = this.runtimes.get(id);
    runtime?.root.classList.add("active");
    runtime?.hooks.onShow?.();

    this.syncTabHighlight(id);
    this.persist();
    this.hooks.requestResize();
  }

  /** Island collapsed: the active widget may stop its animation loops. */
  suspend(): void {
    this.runtimes.get(this.state.active)?.hooks.onCollapse?.();
  }

  /** Island expanded again: the active widget resumes where it left off. */
  resume(): void {
    this.runtimes.get(this.state.active)?.hooks.onExpand?.();
  }

  /** Repaint the tab highlight without re-running the widget's `onShow`. */
  private syncTabHighlight(id: string): void {
    for (const btn of this.tabsEl.querySelectorAll<HTMLElement>("[data-widget]")) {
      const active = btn.dataset.widget === id;
      btn.classList.toggle("active", active);
      // Roving tabindex: Tab enters the bar once, arrows walk inside it.
      btn.tabIndex = active ? 0 : -1;
      btn.setAttribute("aria-selected", active ? "true" : "false");
    }
    this.positionIndicator();
  }

  requestResize(): void {
    this.hooks.requestResize();
  }

  private rebuild(): void {
    // Remove widgets that got disabled.
    for (const [id, runtime] of this.runtimes) {
      if (!this.state.enabled.includes(id)) {
        runtime.hooks.onHide?.();
        runtime.hooks.unmount?.();
        runtime.root.remove();
        this.runtimes.delete(id);
        this.minis.delete(id);
      }
    }

    for (const def of this.orderedDefs()) {
      if (!this.state.enabled.includes(def.id) || this.runtimes.has(def.id)) continue;
      this.mount(def);
    }

    this.renderTabs();
    const active = this.runtimes.has(this.state.active)
      ? this.state.active
      : this.state.enabled[0] ?? "";
    if (active === this.state.active) {
      // Widgets were added or removed, but the active one is still mounted:
      // do not restart it. Re-running `onShow` used to reset the settings
      // scroll position (and rebuild the tab bar under the cursor).
      if (active) this.syncTabHighlight(active);
    } else {
      this.state.active = "";
      if (active) this.setActive(active);
    }
    this.renderMinis();
  }

  private mount(def: WidgetDef): void {
    const root = h("div", "widget");
    root.dataset.widgetRoot = def.id;
    const ctx: WidgetContext = {
      settings: this.settings,
      toast: this.hooks.toast,
      chime: this.hooks.chime,
      alarm: this.hooks.alarm,
      expand: () => this.hooks.expand(def.id),
      collapse: this.hooks.collapse,
      requestResize: () => this.hooks.requestResize(),
      setMini: (node) => {
        if (node) {
          if (this.minis.get(def.id) !== node) this.miniKey = "";
          this.minis.set(def.id, node);
        } else {
          this.minis.delete(def.id);
        }
        this.renderMinis();
      },
    };
    try {
      const hooks = def.mount(root, ctx) ?? {};
      this.hostEl.append(root);
      this.runtimes.set(def.id, { def, root, ctx, hooks });
      if (this.state.active === def.id) root.classList.add("active");
    } catch (err) {
      console.error(`widget ${def.id} failed to mount`, err);
      root.append(h("div", "empty", `Виджет «${def.name}» не загрузился`));
      this.hostEl.append(root);
      this.runtimes.set(def.id, { def, root, ctx, hooks: {} });
    }
  }

  private renderTabs(): void {
    // Rebuilding the bar must not steal or drop keyboard focus.
    const focusedTab = (document.activeElement as HTMLElement | null)?.dataset?.widget;
    this.tabsEl.replaceChildren();
    const indicator = h("span", "tab-indicator");
    indicator.setAttribute("aria-hidden", "true");
    this.tabsEl.append(indicator);
    for (const def of this.orderedDefs()) {
      if (!this.state.enabled.includes(def.id)) continue;
      const btn = h("button", "tab") as HTMLButtonElement;
      btn.type = "button";
      btn.dataset.widget = def.id;
      btn.title = def.name;
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-label", def.name);
      btn.append(icon(def.icon));
      const active = def.id === this.state.active;
      if (active) btn.classList.add("active");
      // Only the active tab is in the Tab order; arrows move inside the bar.
      btn.tabIndex = active ? 0 : -1;
      btn.setAttribute("aria-selected", active ? "true" : "false");
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        this.setActive(def.id);
      });
      this.tabsEl.append(btn);
    }
    // Enter and Space already activate a <button>; arrows are ours (see the
    // single keydown listener installed in the constructor).
    if (focusedTab) {
      this.tabsEl.querySelector<HTMLElement>(`[data-widget="${focusedTab}"]`)?.focus();
    }
    this.positionIndicator();
    requestAnimationFrame(() => this.positionIndicator());
  }

  /**
   * ArrowLeft/ArrowRight walk the tab bar, Home/End jump to the edges.
   * Focus follows the selection, like a native tab strip.
   */
  private onTabKey(event: KeyboardEvent): void {
    const step =
      event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (step === 0 && event.key !== "Home" && event.key !== "End") return;
    const tabs = [...this.tabsEl.querySelectorAll<HTMLElement>("[data-widget]")];
    if (tabs.length === 0) return;
    const focused = tabs.indexOf(document.activeElement as HTMLElement);
    const current =
      focused >= 0
        ? focused
        : tabs.findIndex((tab) => tab.dataset.widget === this.state.active);
    const from = current < 0 ? 0 : current;
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (from + step + tabs.length) % tabs.length;
    event.preventDefault();
    event.stopPropagation();
    const target = tabs[next];
    target.focus();
    const id = target.dataset.widget;
    if (id) this.setActive(id);
  }

  /** Slides the soft highlight under the active tab. */
  private positionIndicator(): void {
    const indicator = this.tabsEl.querySelector<HTMLElement>(".tab-indicator");
    if (!indicator) return;
    const active = this.tabsEl.querySelector<HTMLElement>(".tab.active");
    if (!active) {
      indicator.style.opacity = "0";
      return;
    }
    indicator.style.opacity = "1";
    indicator.style.width = `${active.offsetWidth}px`;
    indicator.style.transform = `translate3d(${active.offsetLeft}px, 0, 0)`;
  }

  private renderMinis(): void {
    const entries = this.orderedDefs()
      .filter((def) => this.state.enabled.includes(def.id))
      .map((def) => ({ def, node: this.minis.get(def.id) }))
      .filter((entry): entry is { def: WidgetDef; node: HTMLElement } => Boolean(entry.node))
      // Media and timers matter most while collapsed; the pill only fits two.
      .sort((a, b) => (a.def.miniPriority ?? 50) - (b.def.miniPriority ?? 50));

    // Timers push updates every second; only the set of chips matters here,
    // widgets repaint their own mini nodes in place.
    const key = (this.settings.value.showMiniWidgets ? "1" : "0") + entries.map((e) => e.def.id).join("|");
    if (key === this.miniKey) return;
    this.miniKey = key;
    this.pillMinis.replaceChildren();
    if (!this.settings.value.showMiniWidgets) return;

    for (const { def, node } of entries) {
      // A real button: the chips are the fastest way into a widget while
      // collapsed, so they must be reachable with Tab and Enter too.
      const chip = h("button", "mini") as HTMLButtonElement;
      chip.type = "button";
      chip.dataset.mini = def.id;
      chip.title = def.name;
      chip.setAttribute("aria-label", `Открыть виджет «${def.name}»`);
      chip.append(icon(def.icon), node);
      chip.addEventListener("click", (event) => {
        event.stopPropagation();
        this.setActive(def.id);
        this.hooks.expand(def.id);
      });
      this.pillMinis.append(chip);
    }
  }

  private persist(): void {
    if (this.saveSoon) return;
    this.saveSoon = true;
    window.setTimeout(() => {
      this.saveSoon = false;
      void api.writeStore("widgets", {
        enabled: this.state.enabled,
        active: this.state.active,
        order: this.orderIds,
      });
    }, 250);
  }
}
