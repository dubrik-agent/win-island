import { api, type HotkeyStatus, type MonitorInfo, type Settings } from "../core/api";
import { h, icon } from "../core/dom";
import { DEFAULT_SETTINGS } from "../core/settings-store";
import { playSound, playUiSound, SOUNDS } from "../core/sound";
import { HOTKEY } from "../core/strings";
import type { WidgetDef } from "../core/widget-types";

/** What the settings UI needs from the island's widget manager. */
export interface SettingsBridge {
  definitions: WidgetDef[];
  isEnabled: (id: string) => boolean;
  toggleEnabled: (id: string, on: boolean) => void;
  /** Persist a new tab order (widget ids, all known widgets). */
  reorder?: (ids: string[]) => void;
}

/** Filled by main.ts (island) or settings-window.ts (standalone). */
export const bridge: {
  manager?: SettingsBridge;
  standalone?: boolean;
  /** Repaint the settings list (e.g. widget switches changed elsewhere). */
  refresh?: () => void;
  /** Pin the panel open while a control is being dragged. */
  hold?: (held: boolean) => void;
} = {};

const THEMES: Array<[Settings["theme"], string]> = [
  ["glass", "Стекло"],
  ["dark", "Тёмная"],
  ["light", "Светлая"],
  ["midnight", "Полночь"],
  ["sand", "Песок"],
];

const TRIGGERS: Array<[Settings["expandTrigger"], string]> = [
  ["hover", "Наведение"],
  ["click", "Клик"],
  ["both", "Наведение + клик"],
];

const MONITOR_MODES: Array<[Settings["monitorMode"], string]> = [
  ["primary", "Основной монитор"],
  ["active", "Монитор активного окна"],
  ["fixed", "Выбранный монитор"],
];

const SHAPES: Array<[Settings["collapsedMode"], string]> = [
  ["line", "Тонкая полоска"],
  ["pill", "Пилюля с часами"],
];

const SHELF_VIEWS: Array<[Settings["shelfView"], string]> = [
  ["list", "Список"],
  ["grid", "Превью"],
];

/**
 * Give the first control inside `node` an accessible name. Screen readers and
 * Windows UI Automation announce range inputs and switches by their label, and
 * a bare `<input type=range>` is otherwise just "slider".
 */
function labelControl(node: HTMLElement, name: string): void {
  const target = node.matches("input, select, textarea")
    ? node
    : node.querySelector<HTMLElement>("input, select, textarea, [role='slider']");
  if (!target) return;
  if (!target.getAttribute("aria-label") && !target.getAttribute("aria-labelledby")) {
    target.setAttribute("aria-label", name);
  }
}

function row(label: string, control: HTMLElement): HTMLElement {
  labelControl(control, label);
  return h("div", "setting-row", h("span", "", label), control);
}

/**
 * Free-form list of process names (no `.exe`). Used by the auto-hide
 * exceptions: while one of these apps is in front, the island stays visible.
 */
function exceptionsBlock(
  value: string[],
  onChange: (list: string[]) => void,
  onAdded?: (process: string) => void,
): HTMLElement {
  const input = h("input", "text-input") as HTMLInputElement;
  input.type = "text";
  input.placeholder = "obs64, vlc, game";
  input.value = value.join(", ");
  input.spellcheck = false;
  input.setAttribute("aria-label", "Приложения-исключения");

  const normalize = (raw: string): string[] => {
    const seen = new Set<string>();
    for (const part of raw.split(",")) {
      const name = part.trim().toLowerCase().replace(/\.exe$/, "");
      if (name) seen.add(name);
    }
    return [...seen];
  };
  const commit = (): void => {
    const list = normalize(input.value);
    input.value = list.join(", ");
    onChange(list);
  };
  input.addEventListener("change", commit);
  input.addEventListener("blur", commit);

  const add = h("button", "btn ghost", "Текущее окно") as HTMLButtonElement;
  add.type = "button";
  add.title = "Добавить приложение, которое сейчас на переднем плане";
  add.addEventListener("click", () => {
    add.disabled = true;
    void api
      .foregroundApp()
      .then((app) => {
        if (!app?.process) return;
        // The settings list rebuild is skipped while a control here has
        // focus, so the field has to be updated by hand.
        const list = normalize(`${input.value}, ${app.process}`);
        input.value = list.join(", ");
        onChange(list);
        onAdded?.(app.process);
      })
      .catch(() => undefined)
      .finally(() => {
        add.disabled = false;
      });
  });

  return h(
    "div",
    "setting-block",
    h("div", "setting-row", h("span", "", "Не скрывать при"), add),
    input,
    h(
      "div",
      "hint",
      "Имена процессов без .exe, через запятую. Пока одно из этих приложений на экране, островок не прячется.",
    ),
  );
}

function toggle(value: boolean, onChange: (checked: boolean) => void): HTMLElement {
  const input = h("input") as HTMLInputElement;
  input.type = "checkbox";
  input.checked = value;
  input.addEventListener("change", () => onChange(input.checked));
  const wrap = h("label", "switch", input, h("i"));
  return wrap;
}

function select<T extends string>(
  options: Array<[T, string]>,
  value: T,
  onChange: (value: T) => void,
): HTMLSelectElement {
  const el = h("select") as HTMLSelectElement;
  for (const [key, label] of options) {
    const opt = h("option", "", label) as HTMLOptionElement;
    opt.value = key;
    el.append(opt);
  }
  el.value = value;
  el.addEventListener("change", () => onChange(el.value as T));
  return el;
}

/**
 * Range row. `onInput` fires continuously while dragging; pass `commit` for
 * controls that move the island window itself — changing the window position
 * under the cursor feeds back into the slider value (it ran away to the max),
 * so those apply once the pointer is released.
 */
function slider(
  min: number,
  max: number,
  step: number,
  value: number,
  format: (v: number) => string,
  onInput: (value: number) => void,
  commit?: (value: number) => void,
): HTMLElement {
  const input = h("input") as HTMLInputElement;
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  const out = h("span", "value", format(value));
  input.addEventListener("input", () => {
    out.textContent = format(Number(input.value));
    if (!commit) onInput(Number(input.value));
  });
  if (commit) {
    let dragging = false;
    // The pointerup listener only exists while a drag is in progress: attaching
    // one per slider on every rebuild leaked a closure for each repaint.
    const release = (): void => {
      if (!dragging) return;
      dragging = false;
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      bridge.hold?.(false);
    };
    input.addEventListener("pointerdown", () => {
      dragging = true;
      // Stops the panel from collapsing once the window moves away from the
      // cursor on release.
      bridge.hold?.(true);
      window.addEventListener("pointerup", release);
      window.addEventListener("pointercancel", release);
    });
    input.addEventListener("change", () => {
      const next = Number(input.value);
      out.textContent = format(next);
      commit(next);
      release();
    });
    input.addEventListener("blur", release);
  }
  return h("div", "row", input, out);
}

// --- collapsible sections ---------------------------------------------------

const SECTION_KEY = "wi.settings.sections";

function readSections(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(SECTION_KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function sectionIsOpen(id: string, byDefault: boolean): boolean {
  const saved = readSections();
  return id in saved ? Boolean(saved[id]) : byDefault;
}

function rememberSection(id: string, open: boolean): void {
  try {
    const saved = readSections();
    saved[id] = open;
    localStorage.setItem(SECTION_KEY, JSON.stringify(saved));
  } catch {
    // Private mode / quota — collapsing still works for this session.
  }
}

const CHEVRON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';

interface SectionOptions {
  /** Open on first run. */
  open?: boolean;
  /** Short right-aligned note, e.g. the current value. */
  note?: string;
  /** Called after the section is toggled (the panel changes height). */
  onToggle?: () => void;
}

function section(
  id: string,
  title: string,
  rows: HTMLElement[],
  options: SectionOptions = {},
): HTMLElement {
  const open = sectionIsOpen(id, options.open ?? true);
  const chevron = icon(CHEVRON);
  chevron.classList.add("sec-chevron");
  const head = h(
    "button",
    "sec-head",
    h("span", "sec-name", title),
    options.note ? h("span", "sec-note", options.note) : null,
    chevron,
  ) as HTMLButtonElement;
  head.type = "button";
  const body = h(
    "div",
    "sec-body",
    h("div", "sec-clip", h("div", "sec-inner", ...rows)),
  );
  const el = h("section", "sec", head, body);
  el.dataset.id = id;
  el.dataset.open = open ? "true" : "false";
  // The header is a disclosure button: screen readers need to know whether the
  // section is open and which block it controls.
  const bodyId = `sec-body-${id}`;
  body.id = bodyId;
  head.setAttribute("aria-expanded", String(open));
  head.setAttribute("aria-controls", bodyId);

  head.addEventListener("click", () => {
    const next = el.dataset.open !== "true";
    el.dataset.open = next ? "true" : "false";
    head.setAttribute("aria-expanded", String(next));
    rememberSection(id, next);
    // The island window follows the panel height.
    options.onToggle?.();
  });

  return el;
}

function hint(text: string): HTMLElement {
  return h("div", "hint", text);
}

/** Row of buttons that fills the section width. */
function actions(...buttons: HTMLElement[]): HTMLElement {
  return h("div", "row row-buttons", ...buttons);
}

/**
 * Destructive action behind a two-step click: the first press only arms the
 * button for a few seconds, so a stray click never wipes the setup.
 */
function dangerButton(label: string, confirmLabel: string, onConfirm: () => void): HTMLButtonElement {
  const btn = h("button", "btn danger", label) as HTMLButtonElement;
  btn.type = "button";
  let armed = false;
  let timer = 0;
  const disarm = (): void => {
    armed = false;
    btn.textContent = label;
    btn.classList.remove("armed");
    window.clearTimeout(timer);
  };
  btn.addEventListener("click", () => {
    if (!armed) {
      armed = true;
      btn.textContent = confirmLabel;
      btn.classList.add("armed");
      timer = window.setTimeout(disarm, 4000);
      return;
    }
    disarm();
    onConfirm();
  });
  return btn;
}

// --- global hotkeys ---------------------------------------------------------

type HotkeyAction = "toggle" | "hide" | "settings";

const HOTKEY_SETTING: Record<HotkeyAction, "hotkeyToggle" | "hotkeyHide" | "hotkeySettings"> = {
  toggle: "hotkeyToggle",
  hide: "hotkeyHide",
  settings: "hotkeySettings",
};

const MODIFIER_CODES = /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/;

/** Turn a keydown into the `Ctrl+Alt+K` text the Rust side parses. */
function comboFromEvent(event: KeyboardEvent): string | null {
  if (!event.code || MODIFIER_CODES.test(event.code)) return null;
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Super");
  // A bare letter would hijack global typing, so require a modifier.
  if (parts.length === 0) return null;

  const code = event.code;
  const key = code.startsWith("Key")
    ? code.slice(3)
    : code.startsWith("Digit")
      ? code.slice(5)
      : code === "Escape"
        ? "Esc"
        : code === "ArrowUp"
          ? "Up"
          : code === "ArrowDown"
            ? "Down"
            : code === "ArrowLeft"
              ? "Left"
              : code === "ArrowRight"
                ? "Right"
                : code;
  return [...parts, key].join("+");
}

/** `null` = the key is taken by another action of this app. */
function duplicateOf(action: HotkeyAction, combo: string, s: Settings): string | null {
  for (const other of Object.keys(HOTKEY_SETTING) as HotkeyAction[]) {
    if (other === action) continue;
    if (s[HOTKEY_SETTING[other]].toLowerCase() === combo.toLowerCase()) {
      const names: Record<HotkeyAction, string> = {
        toggle: "«Показать / скрыть»",
        hide: "«Скрыть островок»",
        settings: "«Настройки»",
      };
      return `уже занята действием ${names[other]}`;
    }
  }
  return null;
}

function statusText(error: string | null): string {
  if (!error) return "";
  return /already registered/i.test(error) ? HOTKEY.busy : "не удалось зарегистрировать";
}

/**
 * Click-to-record hotkey field. Keeping it a button (not an input) means the
 * keyboard never inserts text, and Esc always cancels.
 */
function hotkeyField(
  value: string,
  status: string | null,
  onPick: (combo: string) => string | null,
): HTMLElement {
  const btn = h("button", "hk-field", value) as HTMLButtonElement;
  btn.type = "button";
  btn.title = "Нажмите, чтобы записать новое сочетание";
  const note = h("span", "hk-status", statusText(status));
  if (status) note.title = status;
  note.classList.toggle("error", Boolean(status));
  const wrap = h("div", "hk-wrap", btn, note);

  let recording = false;
  let shown = value;

  const stop = (): void => {
    recording = false;
    btn.classList.remove("recording");
    btn.textContent = shown;
    window.removeEventListener("keydown", onKey, true);
  };

  const onKey = (event: KeyboardEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      stop();
      note.textContent = statusText(status);
      note.classList.toggle("error", Boolean(status));
      return;
    }
    const combo = comboFromEvent(event);
    if (!combo) {
      note.textContent = HOTKEY.needModifier;
      note.classList.add("error");
      return;
    }
    const problem = onPick(combo);
    stop();
    if (problem) {
      note.textContent = problem;
      note.title = problem;
      note.classList.add("error");
      return;
    }
    shown = combo;
    btn.textContent = combo;
    note.textContent = HOTKEY.checking;
    note.title = "";
    note.classList.remove("error");
  };

  btn.addEventListener("click", () => {
    if (recording) {
      stop();
      return;
    }
    recording = true;
    btn.classList.add("recording");
    btn.textContent = HOTKEY.pressCombo;
    note.textContent = HOTKEY.escCancel;
    note.classList.remove("error");
    btn.blur();
    window.addEventListener("keydown", onKey, true);
  });

  return wrap;
}

let monitorsCache: MonitorInfo[] | null = null;

/** Last registration result reported by the native side. */
let hotkeyStatus: HotkeyStatus | null = null;

async function loadMonitors(): Promise<MonitorInfo[]> {
  if (monitorsCache) return monitorsCache;
  try {
    monitorsCache = await api.monitors();
  } catch {
    monitorsCache = [];
  }
  return monitorsCache;
}

export const settingsWidget: WidgetDef = {
  id: "settings",
  name: "Настройки",
  alwaysEnabled: true,
  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.1"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1z"/></svg>`,
  mount(root, ctx) {
    const container = h("div", "settings");
    const settings = ctx.settings;
    let monitors: MonitorInfo[] = [];

    /**
     * Re-fit the island window after a section grows or shrinks. A
     * ResizeObserver tracks the real content height instead of polling
     * `requestResize()` for 300 ms on every toggle — that loop cost ~18 IPC
     * round-trips per click.
     */
    let resizeRaf = 0;
    const refit = (): void => {
      if (resizeRaf) return;
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        ctx.requestResize();
      });
    };
    const observer = new ResizeObserver(refit);
    observer.observe(container);

    /**
     * Live mini-model of the island. While the panel is open the collapsed
     * shape is hidden behind it, so width/thickness sliders had no visible
     * feedback at all. Everything is drawn at one scale, so the line and the
     * panel keep their real proportions.
     */
    const preview = (() => {
      const SCALE = 0.5;
      const frame = h("div", "geo");
      const monitor = h("div", "geo-monitor");
      const bar = h("div", "geo-bar");
      const panel = h("div", "geo-panel");
      const caption = h("div", "geo-caption");
      monitor.append(bar);
      frame.append(monitor, panel, caption);

      const paint = (s: Settings): void => {
        const line = s.collapsedMode === "line";
        const w = line ? s.lineWidth : s.pillWidth;
        const hgt = line ? s.lineHeight : s.pillHeight;
        bar.dataset.mode = s.collapsedMode;
        bar.style.width = `${Math.max(6, w * SCALE)}px`;
        bar.style.height = `${Math.max(2, hgt * SCALE)}px`;
        bar.style.borderRadius = `${(line ? hgt / 2 : Math.min(hgt / 2, w / 2)) * SCALE}px`;
        panel.style.width = `${Math.max(40, s.panelWidth * SCALE)}px`;
        panel.style.borderRadius = `${s.panelRadius * SCALE}px`;
        caption.textContent = `${line ? "Полоска" : "Пилюля"} ${Math.round(w)} × ${Math.round(
          hgt,
        )} px · панель ${Math.round(s.panelWidth)} px · радиус ${Math.round(s.panelRadius)} px`;
      };

      paint(settings.value);
      const off = settings.subscribe(paint);
      return { node: frame, dispose: off };
    })();

    const rebuild = (): void => {
      const s = settings.value;
      const scroll = container.scrollTop;
      container.replaceChildren();

      const monitorSelect = select(
        monitors.length
          ? monitors.map((m) => [String(m.index), `${m.name}${m.isPrimary ? " (осн.)" : ""}`])
          : [["0", "Монитор 1"]],
        String(s.monitorIndex),
        (value) => settings.patch({ monitorIndex: Number(value) }),
      );

      const widgets = bridge.manager?.definitions.filter((d) => !d.alwaysEnabled) ?? [];

      /** Persist the row order as the new tab order. */
      const commitOrder = (): void => {
        const ids = [...container.querySelectorAll<HTMLElement>(".widget-row")].map(
          (row) => row.dataset.widgetId ?? "",
        );
        const all = bridge.manager?.definitions.map((def) => def.id) ?? [];
        const merged = [...ids, ...all.filter((id) => !ids.includes(id))];
        bridge.manager?.reorder?.(merged);
        rebuild();
      };

      /** Move a widget one row up (delta -1) or down (+1). */
      const moveBy = (id: string, delta: number): void => {
        const rows = [...container.querySelectorAll<HTMLElement>(".widget-row")];
        const index = rows.findIndex((row) => row.dataset.widgetId === id);
        const target = index + delta;
        if (index < 0 || target < 0 || target >= rows.length) return;
        if (delta < 0) rows[target].before(rows[index]);
        else rows[target].after(rows[index]);
        commitOrder();
      };

      let draggingId = "";

      const widgetRows = widgets.map((def, index) => {
        const grip = h("span", "drag-grip", "⠿");
        grip.title = "Перетащите строку, чтобы изменить порядок вкладок";
        grip.setAttribute("aria-hidden", "true");

        const up = h("button", "move-btn", "↑") as HTMLButtonElement;
        up.type = "button";
        up.title = "Выше";
        up.setAttribute("aria-label", `Поднять «${def.name}» выше`);
        up.disabled = index === 0;
        up.addEventListener("click", () => moveBy(def.id, -1));

        const down = h("button", "move-btn", "↓") as HTMLButtonElement;
        down.type = "button";
        down.title = "Ниже";
        down.setAttribute("aria-label", `Опустить «${def.name}» ниже`);
        down.disabled = index === widgets.length - 1;
        down.addEventListener("click", () => moveBy(def.id, 1));

        const rowEl = h(
          "div",
          "setting-row widget-row",
          grip,
          h("span", "widget-name", def.name),
          h("span", "widget-move", up, down),
          toggle(bridge.manager?.isEnabled(def.id) ?? false, (checked) => {
            bridge.manager?.toggleEnabled(def.id, checked);
            ctx.requestResize();
          }),
        );
        labelControl(rowEl, `Показывать виджет «${def.name}»`);
        rowEl.dataset.widgetId = def.id;
        rowEl.draggable = true;

        rowEl.addEventListener("dragstart", (event) => {
          draggingId = def.id;
          rowEl.classList.add("dragging");
          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", def.id);
          }
        });
        rowEl.addEventListener("dragend", () => {
          draggingId = "";
          rowEl.classList.remove("dragging");
          commitOrder();
        });
        rowEl.addEventListener("dragover", (event) => {
          if (!draggingId || draggingId === def.id) return;
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
          const dragged = container.querySelector<HTMLElement>(
            `.widget-row[data-widget-id="${draggingId}"]`,
          );
          if (!dragged) return;
          const rect = rowEl.getBoundingClientRect();
          const after = event.clientY > rect.top + rect.height / 2;
          if (after) rowEl.after(dragged);
          else rowEl.before(dragged);
        });
        rowEl.addEventListener("drop", (event) => event.preventDefault());
        return rowEl;
      });

      const accentInput = h("input") as HTMLInputElement;
      accentInput.type = "color";
      accentInput.value = s.accent;
      accentInput.addEventListener("input", () => settings.patch({ accent: accentInput.value }));

      const line = s.collapsedMode === "line";
      const pill = !line;
      const glass = s.theme === "glass";

      container.append(
        section(
          "help",
          "Что здесь можно",
          [
            h(
              "ul",
              "help-list",
              h("li", "", "Наведите курсор на полоску сверху экрана — панель раскроется. Esc или стрелка справа — свернуть."),
              h("li", "", "Медиа: обложка, перемотка, play/pause — из любого плеера, который видит Windows."),
              h("li", "", "Полка: перетащите файлы на островок или вставьте из буфера, чтобы держать их под рукой."),
              h("li", "", "Заметки с чек-листами, планы на день в календаре, таймер, напоминания, система и калькулятор."),
            ),
            hint("Все разделы — вкладки в шапке панели. Правый клик по иконке в трее — «Настройки»."),
            ...(bridge.standalone
              ? []
              : [
                  h(
                    "div",
                    "row",
                    (() => {
                      const btn = h("button", "btn", "Открыть настройки в отдельном окне");
                      btn.addEventListener("click", () => void api.openSettingsWindow());
                      return btn;
                    })(),
                  ),
                ]),
          ],
          { open: false, onToggle: refit },
        ),
        section(
          "appearance",
          "Внешний вид",
          [
            row(
              "Тема",
              select(THEMES, s.theme, (theme) => {
                settings.patch({ theme });
                rebuild();
              }),
            ),
            row("Акцент", accentInput),
            ...(glass
              ? [
                  row(
                    "Прозрачность",
                    slider(
                      0.5,
                      1,
                      0.02,
                      s.opacity,
                      (v) => `${Math.round(v * 100)}%`,
                      (opacity) => settings.patch({ opacity }),
                    ),
                  ),
                ]
              : []),
            row(
              "Масштаб",
              slider(0.8, 1.3, 0.01, s.scale, (v) => `${Math.round(v * 100)}%`, (scale) =>
                settings.patch({ scale }),
              ),
            ),
            row("Анимации", toggle(s.animations, (animations) => settings.patch({ animations }))),
            ...(s.animations
              ? [
                  row(
                    "Скорость анимации",
                    slider(
                      120,
                      900,
                      20,
                      s.animationMs,
                      (v) => `${v} мс`,
                      (animationMs) => settings.patch({ animationMs }),
                    ),
                  ),
                ]
              : []),
            row(
              "Тень",
              toggle(s.shadow, (shadow) => {
                settings.patch({ shadow });
                // The native region is recomputed by the island itself; this
                // only keeps the preview honest.
                rebuild();
              }),
            ),
            hint(
              "Мягкая тень рисуется внутри островка, поэтому клики рядом с ним всегда попадают в окно под ним.",
            ),
          ],
          {
            note: THEMES.find(([key]) => key === s.theme)?.[1] ?? "",
            onToggle: refit,
          },
        ),
        section(
          "sounds",
          "Звуки интерфейса",
          [
            row(
              "Звуки панели",
              toggle(s.uiSounds, (uiSounds) => settings.patch({ uiSounds })),
            ),
            ...(s.uiSounds
              ? [
                  row(
                    "Громкость",
                    slider(
                      0,
                      1,
                      0.05,
                      s.uiSoundVolume,
                      (v) => `${Math.round(v * 100)}%`,
                      (uiSoundVolume) => settings.patch({ uiSoundVolume }),
                    ),
                  ),
                  row(
                    "Проверить",
                    (() => {
                      const btn = h("button", "btn", "Развернуть звук");
                      btn.addEventListener("click", () => {
                        const value = settings.value;
                        playUiSound("expand", value.uiSounds, value.uiSoundVolume);
                        window.setTimeout(
                          () => playUiSound("tab", value.uiSounds, value.uiSoundVolume),
                          180,
                        );
                      });
                      return btn;
                    })(),
                  ),
                ]
              : []),
            hint(
              "Короткие тихие отклики на раскрытие, смену вкладки и перетаскивание файлов. Полностью отключаются здесь.",
            ),
          ],
          { open: false, onToggle: refit },
        ),
        section(
          "shape",
          "Форма и размер",
          [
            preview.node,
            row(
              "Свёрнутый вид",
              select(SHAPES, s.collapsedMode, (collapsedMode) => {
                settings.patch({ collapsedMode });
                rebuild();
              }),
            ),
            ...(line
              ? [
                  row(
                    "Длина полоски",
                    slider(60, 320, 2, s.lineWidth, (v) => `${v} px`, (lineWidth) =>
                      settings.patch({ lineWidth }),
                    ),
                  ),
                  row(
                    "Толщина полоски",
                    slider(3, 18, 1, s.lineHeight, (v) => `${v} px`, (lineHeight) =>
                      settings.patch({ lineHeight }),
                    ),
                  ),
                ]
              : [
                  row(
                    "Ширина пилюли",
                    slider(160, 360, 2, s.pillWidth, (v) => `${v} px`, (pillWidth) =>
                      settings.patch({ pillWidth }),
                    ),
                  ),
                  row(
                    "Высота шапки",
                    slider(26, 48, 1, s.pillHeight, (v) => `${v} px`, (pillHeight) =>
                      settings.patch({ pillHeight }),
                    ),
                  ),
                ]),
            row(
              "Ширина панели",
              slider(340, 620, 4, s.panelWidth, (v) => `${v} px`, (panelWidth) =>
                settings.patch({ panelWidth }),
              ),
            ),
            row(
              "Скругление панели",
              slider(0, 36, 1, s.panelRadius, (v) => `${v} px`, (panelRadius) =>
                settings.patch({ panelRadius }),
              ),
            ),
            hint(
              line
                ? "Полоска почти не закрывает вкладки браузера и раскрывается при наведении."
                : "Пилюля показывает часы и мини-индикаторы. Для максимально ненавязчивого вида выберите «Тонкая полоска».",
            ),
          ],
          {
            note: line ? `${Math.round(s.lineWidth)} × ${Math.round(s.lineHeight)}` : `${Math.round(s.pillWidth)} px`,
            onToggle: refit,
          },
        ),
        section(
          "position",
          "Положение",
          [
            row(
              "Монитор",
              select(MONITOR_MODES, s.monitorMode, (monitorMode) => {
                settings.patch({ monitorMode });
                rebuild();
              }),
            ),
            ...(s.monitorMode === "fixed" ? [row("Конкретный монитор", monitorSelect)] : []),
            ...(s.monitorMode === "active"
              ? [
                  row(
                    "Следовать за активным окном",
                    toggle(s.monitorFollow, (monitorFollow) => settings.patch({ monitorFollow })),
                  ),
                ]
              : []),
            row(
              "Смещение по горизонтали",
              slider(
                -600,
                600,
                5,
                s.offsetX,
                (v) => `${v} px`,
                () => undefined,
                (offsetX) => settings.patch({ offsetX }),
              ),
            ),
            row(
              "Отступ сверху",
              slider(
                0,
                60,
                1,
                s.topOffset,
                (v) => `${v} px`,
                () => undefined,
                (topOffset) => settings.patch({ topOffset }),
              ),
            ),
            row(
              "Зафиксировать позицию",
              toggle(s.pinnedPosition, (pinnedPosition) => settings.patch({ pinnedPosition })),
            ),
            actions(
              (() => {
                const btn = h("button", "btn", "Центрировать");
                btn.addEventListener("click", () => {
                  settings.patch({ offsetX: 0 });
                  ctx.toast("Островок по центру");
                });
                return btn;
              })(),
            ),
            hint(
              "Смещение и отступ применяются, когда отпускаете ползунок: островок сразу переезжает.",
            ),
          ],
          { onToggle: refit },
        ),
        section(
          "behavior",
          "Поведение",
          [
            row(
              "Раскрытие",
              select(TRIGGERS, s.expandTrigger, (expandTrigger) => {
                settings.patch({ expandTrigger });
                rebuild();
              }),
            ),
            ...(s.expandTrigger === "click"
              ? []
              : [
                  row(
                    "Задержка наведения",
                    slider(0, 600, 10, s.hoverDelayMs, (v) => `${v} мс`, (hoverDelayMs) =>
                      settings.patch({ hoverDelayMs }),
                    ),
                  ),
                ]),
            ...(pill
              ? [
                  row(
                    "Часы в свёрнутом виде",
                    toggle(s.showClock, (showClock) => settings.patch({ showClock })),
                  ),
                  row(
                    "Мини-виджеты в свёрнутом виде",
                    toggle(s.showMiniWidgets, (showMiniWidgets) =>
                      settings.patch({ showMiniWidgets }),
                    ),
                  ),
                ]
              : []),
            row("Автоскрытие", toggle(s.autoHide, (autoHide) => settings.patch({ autoHide }))),
            ...(s.autoHide
              ? [
                  row(
                    "Задержка автоскрытия",
                    slider(
                      3,
                      60,
                      1,
                      Math.round(s.autoHideDelayMs / 1000),
                      (v) => `${v} с`,
                      (v) => settings.patch({ autoHideDelayMs: v * 1000 }),
                    ),
                  ),
                ]
              : []),
            row(
              "Скрывать в полноэкранных приложениях",
              toggle(s.hideInFullscreen, (hideInFullscreen) => settings.patch({ hideInFullscreen })),
            ),
            row(
              "Скрывать в максимизированных окнах",
              toggle(s.hideOnMaximized, (hideOnMaximized) => settings.patch({ hideOnMaximized })),
            ),
            ...(s.autoHide || s.hideInFullscreen || s.hideOnMaximized
              ? [
                  exceptionsBlock(
                    s.autoHideExceptions ?? [],
                    (autoHideExceptions) => settings.patch({ autoHideExceptions }),
                    (process) => ctx.toast(`Исключение: ${process}`),
                  ),
                ]
              : []),
          ],
          { onToggle: refit },
        ),
        section("widgets", "Виджеты", widgetRows, { onToggle: refit }),
        section(
          "system",
          "Система",
          [
            row("Загрузка процессора", toggle(s.sysCpu, (sysCpu) => settings.patch({ sysCpu }))),
            row("Оперативная память", toggle(s.sysRam, (sysRam) => settings.patch({ sysRam }))),
            row("Место на дисках", toggle(s.sysDisks, (sysDisks) => settings.patch({ sysDisks }))),
            row("Время работы", toggle(s.sysUptime, (sysUptime) => settings.patch({ sysUptime }))),
            hint(
              "Что показывать во вкладке «Система». Диски читаются в фоне и не подвешивают панель.",
            ),
          ],
          { open: false, onToggle: refit },
        ),
        section(
          "shelf",
          "Полка",
          [
            row(
              "Вид",
              select(SHELF_VIEWS, s.shelfView, (shelfView) => {
                settings.patch({ shelfView });
                rebuild();
              }),
            ),
            hint(
              "«Превью» показывает миниатюры фотографий и кадр из видео; «Список» — компактные строки с иконками.",
            ),
          ],
          { open: false, onToggle: refit },
        ),
        section(
          "reminders",
          "Напоминания",
          [
            row(
              "Звук",
              select(SOUNDS, s.reminderSound, (reminderSound) => settings.patch({ reminderSound })),
            ),
            row(
              "Громкость",
              slider(
                0,
                1,
                0.05,
                s.reminderVolume,
                (v) => `${Math.round(v * 100)}%`,
                (reminderVolume) => settings.patch({ reminderVolume }),
              ),
            ),
            row(
              "Проверить звук",
              (() => {
                const btn = h("button", "btn", "Прослушать");
                btn.addEventListener("click", () => {
                  void playSound(settings.value.reminderSound, settings.value.reminderVolume);
                });
                return btn;
              })(),
            ),
            row(
              "Звук не замолкает",
              toggle(s.reminderAlarm, (reminderAlarm) => settings.patch({ reminderAlarm })),
            ),
            hint(
              "Пока включено, напоминание повторяется каждые 4 секунды, а панель остаётся раскрытой, пока вы не нажмёте «Остановить» над вкладками.",
            ),
          ],
          { open: false, onToggle: refit },
        ),
        section(
          "hotkeys",
          "Горячие клавиши",
          [
            ...(["toggle", "hide", "settings"] as HotkeyAction[]).map((action) => {
              const names: Record<HotkeyAction, string> = {
                toggle: "Показать / скрыть",
                hide: "Скрыть островок",
                settings: "Настройки",
              };
              return row(
                names[action],
                hotkeyField(
                  s[HOTKEY_SETTING[action]],
                  hotkeyStatus ? hotkeyStatus[action] : null,
                  (combo) => {
                    const problem = duplicateOf(action, combo, settings.value);
                    if (problem) return problem;
                    const previous = settings.value[HOTKEY_SETTING[action]];
                    const next: Partial<Settings> = {};
                    next[HOTKEY_SETTING[action]] = combo;
                    settings.patch(next);
                    window.setTimeout(() => {
                      void api.hotkeyStatus().then((status) => {
                        hotkeyStatus = status;
                        if (!status[action]) {
                          rebuild();
                          return;
                        }
                        // Windows refused the combo (another app owns it).
                        // Put the working one back instead of leaving the
                        // user without a hotkey.
                        const back: Partial<Settings> = {};
                        back[HOTKEY_SETTING[action]] = previous;
                        settings.patch(back);
                        window.setTimeout(() => {
                          void api.hotkeyStatus().then((after) => {
                            hotkeyStatus = after;
                            rebuild();
                            ctx.toast(`Сочетание занято — оставил ${previous}`);
                          });
                        }, 450);
                      });
                    }, 500);
                    return null;
                  },
                ),
              );
            }),
            hint(
              "Нажмите на поле и введите сочетание с Ctrl, Alt, Shift или Win. Изменения применяются сразу.",
            ),
          ],
          { open: false, onToggle: refit },
        ),
        section(
          "data",
          "Данные и приложение",
          [
            ...(bridge.standalone
              ? [
                  actions(
                    (() => {
                      const btn = h("button", "btn primary", "Развернуть островок");
                      btn.addEventListener("click", () => void api.setIslandExpanded(true));
                      return btn;
                    })(),
                    (() => {
                      const btn = h("button", "btn", "Свернуть островок");
                      btn.addEventListener("click", () => void api.setIslandExpanded(false));
                      return btn;
                    })(),
                  ),
                ]
              : []),
            actions(
              (() => {
                const btn = h("button", "btn", "Папка данных");
                btn.addEventListener("click", () => void api.openData());
                return btn;
              })(),
              (() => {
                const btn = h("button", "btn", "Логи");
                btn.title = "Открыть data/logs — для отчёта об ошибке";
                btn.addEventListener("click", () => void api.openLogs());
                return btn;
              })(),
              (() => {
                const btn = h("button", "btn", "Скрыть островок");
                btn.addEventListener("click", () => void api.hide());
                return btn;
              })(),
              (() => {
                const btn = h("button", "btn", "Выход");
                btn.addEventListener("click", () => void api.quit());
                return btn;
              })(),
            ),
            actions(
              dangerButton("По умолчанию", "Точно сбросить?", () => {
                settings.patch({ ...DEFAULT_SETTINGS });
                ctx.toast("Настройки сброшены");
                rebuild();
              }),
            ),
            hint(
              "«По умолчанию» вернёт тему, форму, положение и горячие клавиши к заводским значениям — и сохранит их.",
            ),
          ],
          { open: false, onToggle: refit },
        ),
        section(
          "advanced",
          "Экспериментальные функции",
          [
            row(
              "Виджеты из папки",
              toggle(s.experimentalWidgets, (experimentalWidgets) =>
                settings.patch({ experimentalWidgets }),
              ),
            ),
            hint("Загрузка внешних виджетов (HTML/JS) — появится в следующем обновлении."),
          ],
          { open: false, onToggle: refit },
        ),
      );
      container.scrollTop = scroll;
    };
    bridge.refresh = rebuild;

    /** Pull the registration result from the native side and repaint. */
    const loadHotkeys = (): void => {
      if (!api.available) return;
      void api
        .hotkeyStatus()
        .then((status) => {
          hotkeyStatus = status;
          if (container.isConnected) rebuild();
        })
        .catch(() => undefined);
    };

    // Another window can change the settings too (island drag, tray, hotkeys).
    // Never rebuild under the user's cursor while a control is being dragged.
    let rebuildTimer = 0;
    const off = settings.subscribe(() => {
      const focused = document.activeElement;
      if (focused && focused !== document.body && container.contains(focused)) return;
      window.clearTimeout(rebuildTimer);
      rebuildTimer = window.setTimeout(rebuild, 140);
    });

    rebuild();
    void loadMonitors().then((list) => {
      monitors = list;
      rebuild();
    });
    loadHotkeys();

    root.append(container);
    return {
      onShow: () => {
        // The panel height animates after this hook fires; reset once laid out.
        container.scrollTop = 0;
        requestAnimationFrame(() => {
          container.scrollTop = 0;
        });
      },
      unmount: () => {
        off();
        observer.disconnect();
        if (resizeRaf) cancelAnimationFrame(resizeRaf);
        preview.dispose();
        window.clearTimeout(rebuildTimer);
        if (bridge.refresh === rebuild) bridge.refresh = undefined;
      },
    };
  },
};
