import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { api, type Settings } from "./core/api";
import { h } from "./core/dom";
import { motionAllowed, onReducedMotionChange } from "./core/motion";
import { SettingsStore } from "./core/settings-store";
import { widgetDefs } from "./widgets";
import { bridge, settingsWidget } from "./widgets/settings";

interface WidgetsPayload {
  enabled: string[];
  active?: string;
  order?: string[];
}

const WIDGET_STATE_EVENT = "island://widgets-changed";
const WIDGET_REQUEST_EVENT = "island://widgets-request";

/**
 * Full-window settings panel. The island only ever shows a small tab; the
 * heavy list of options lives in its own native window.
 */
export async function bootstrapSettingsWindow(): Promise<void> {
  document.body.classList.add("settings-window");
  // Opaque page from the very first frame: the native window background is
  // dark and a transparent body would otherwise read as a white window.
  document.documentElement.style.background = "#0b0b0f";
  document.title = "Win Island — Настройки";

  const settings = new SettingsStore();
  await settings.load();

  // --- widget enable state -------------------------------------------------
  const defaultEnabled = new Set(
    widgetDefs.filter((def) => def.defaultEnabled || def.alwaysEnabled).map((def) => def.id),
  );
  const saved = await api.readStore<WidgetsPayload>("widgets");
  const enabled = new Set<string>(defaultEnabled);
  for (const id of saved?.enabled ?? []) {
    if (widgetDefs.some((def) => def.id === id)) enabled.add(id);
  }
  let activeId = saved?.active ?? "";
  if (!enabled.has(activeId)) activeId = [...enabled][0] ?? "";

  /** Saved tab order; unknown/new widgets fall back to declaration order. */
  let order: string[] = Array.isArray(saved?.order)
    ? saved.order.filter((id) => widgetDefs.some((def) => def.id === id))
    : [];

  const orderedDefs = (): typeof widgetDefs => {
    if (order.length === 0) return widgetDefs;
    const rank = new Map(order.map((id, index) => [id, index]));
    return [...widgetDefs].sort((a, b) => {
      const ra = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const rb = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      if (ra === rb) return widgetDefs.indexOf(a) - widgetDefs.indexOf(b);
      return ra - rb;
    });
  };

  const persistWidgets = (): void => {
    const list = orderedDefs()
      .filter((def) => enabled.has(def.id))
      .map((def) => def.id);
    const ids = orderedDefs().map((def) => def.id);
    void api.writeStore("widgets", { enabled: list, active: activeId, order: ids });
    void emit(WIDGET_STATE_EVENT, { enabled: list, active: activeId, order: ids }).catch(
      () => undefined,
    );
  };

  bridge.standalone = true;
  bridge.manager = {
    get definitions() {
      return orderedDefs();
    },
    isEnabled: (id) => enabled.has(id),
    reorder: (ids) => {
      const known = new Set(widgetDefs.map((def) => def.id));
      const seen = new Set<string>();
      order = [];
      for (const id of ids) {
        if (!known.has(id) || seen.has(id)) continue;
        seen.add(id);
        order.push(id);
      }
      persistWidgets();
      bridge.refresh?.();
    },
    toggleEnabled: (id, on) => {
      const def = widgetDefs.find((item) => item.id === id);
      if (!def || def.alwaysEnabled) return;
      if (on) enabled.add(id);
      else enabled.delete(id);
      if (enabled.size === 0) {
        enabled.add(id);
        return;
      }
      if (!enabled.has(activeId)) activeId = widgetDefs.find((d) => enabled.has(d.id))?.id ?? "";
      persistWidgets();
      bridge.refresh?.();
    },
  };

  // --- page shell ----------------------------------------------------------
  const host = h("div", "sw-host");
  const close = h("button", "sw-close", "Готово");
  close.addEventListener("click", () => void getCurrentWindow().close());

  const page = h(
    "div",
    "sw-page",
    h(
      "header",
      "sw-head",
      h(
        "div",
        "sw-brand",
        h("span", "dot-pulse"),
        h("div", "sw-titles", h("h1", "", "Win Island"), h("p", "", "Настройки")),
      ),
      close,
    ),
    host,
  );
  document.body.append(page);

  const root = h("div", "widget active");
  host.append(root);
  const hooks = settingsWidget.mount(root, {
    settings,
    toast: () => undefined,
    setMini: () => undefined,
    expand: () => undefined,
    collapse: () => undefined,
    requestResize: () => undefined,
    chime: () => undefined,
    alarm: () => undefined,
  });
  hooks?.onShow?.();

  // --- live sync -----------------------------------------------------------
  const paint = (s: Settings): void => {
    const light = s.theme === "light" || s.theme === "sand";
    document.body.dataset.theme = s.theme;
    document.body.dataset.tone = light ? "light" : "dark";
    // Same rule as the island: the system «уменьшить движение» wins.
    document.body.dataset.anim = motionAllowed(s.animations) ? "on" : "off";
    // Mirror for the pre-paint script in index.html (no flash on next start).
    try {
      localStorage.setItem("wi.theme", s.theme);
      localStorage.setItem("wi.accent", s.accent);
    } catch {
      /* private mode */
    }
    document.documentElement.style.background =
      s.theme === "sand"
        ? "#f3eee4"
        : s.theme === "midnight"
          ? "#0b0d16"
          : light
            ? "#f4f4f8"
            : "#0b0b0f";
    document.body.style.setProperty("--accent", s.accent);
    document.documentElement.style.colorScheme = light ? "light" : "dark";
    void getCurrentWindow()
      .setTheme(light ? "light" : "dark")
      .catch(() => undefined);
  };
  paint(settings.value);
  settings.subscribe(paint);
  onReducedMotionChange(() => paint(settings.value));

  await listen<Settings>("island://settings-changed", (event) => {
    settings.replace(event.payload);
  });

  await listen<WidgetsPayload>(WIDGET_STATE_EVENT, (event) => {
    const list = event.payload?.enabled;
    if (!Array.isArray(list)) return;
    const next = new Set(list.filter((id) => widgetDefs.some((def) => def.id === id)));
    for (const def of widgetDefs) if (def.alwaysEnabled) next.add(def.id);
    const incoming = Array.isArray(event.payload?.order)
      ? event.payload.order.filter((id) => widgetDefs.some((def) => def.id === id))
      : order;
    const sameEnabled = next.size === enabled.size && [...next].every((id) => enabled.has(id));
    const sameOrder = incoming.join("|") === order.join("|");
    if (sameEnabled && sameOrder) return;
    enabled.clear();
    for (const id of next) enabled.add(id);
    order = [...incoming];
    if (!enabled.has(activeId)) activeId = [...enabled][0] ?? "";
    bridge.refresh?.();
  });

  // The island owns the widget manager; ask it for the live state.
  void emit(WIDGET_REQUEST_EVENT).catch(() => undefined);
  window.addEventListener("focus", () => {
    void emit(WIDGET_REQUEST_EVENT).catch(() => undefined);
  });

  // Esc closes the window — the same gesture as the island panel. The hotkey
  // recorder stops the event in the capture phase, so recording still cancels.
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    void getCurrentWindow()
      .close()
      .catch(() => undefined);
  });
}
