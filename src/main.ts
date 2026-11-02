import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { api } from "./core/api";
import { AlarmCenter } from "./core/alarm";
import { h } from "./core/dom";
import { escapeLayerCount, pushEscapeLayer } from "./core/escape";
import { Island } from "./core/island";
import { SettingsStore } from "./core/settings-store";
import { primeAudio, playSound } from "./core/sound";
import { WidgetManager } from "./core/widget-manager";
import { bootstrapSettingsWindow } from "./settings-window";
import { widgetDefs } from "./widgets";
import { bridge } from "./widgets/settings";
import { shelfBridge } from "./widgets/shelf";

const CLOCK_INTERVAL = 5000;
const AUTO_HIDE_CHECK = 1500;

function toast(message: string): void {
  const host = document.getElementById("toast-host");
  if (!host) return;
  const node = h("div", "toast", message);
  host.append(node);
  window.setTimeout(() => {
    node.classList.add("out");
    window.setTimeout(() => node.remove(), 220);
  }, 3200);
}

async function bootstrap(): Promise<void> {
  const settings = new SettingsStore();
  await settings.load();

  const root = document.getElementById("island");
  const panel = document.getElementById("panel");
  const host = document.getElementById("widget-host");
  const tabs = document.getElementById("tabs");
  const pillMinis = document.getElementById("pill-minis");
  const clock = document.getElementById("pill-clock");
  const alarmHost = document.getElementById("alarm-host");
  if (!root || !panel || !host || !tabs || !pillMinis || !clock || !alarmHost) {
    throw new Error("island markup is missing");
  }

  let autoHideTimer: number | undefined;
  let autoHideArmed = false;
  let dropCloseTimer = 0;

  /**
   * The foreground app is on the auto-hide exception list, so the island must
   * stay visible (fullscreen games, OBS, video players).
   */
  const isExceptedApp = async (): Promise<boolean> => {
    const list = settings.value.autoHideExceptions;
    if (!Array.isArray(list) || list.length === 0) return false;
    try {
      const app = await api.foregroundApp();
      if (!app?.process) return false;
      return list.some(
        (entry) => entry.trim().toLowerCase().replace(/\.exe$/, "") === app.process,
      );
    } catch {
      return false;
    }
  };

  const scheduleAutoHide = (): void => {
    window.clearTimeout(autoHideTimer);
    autoHideArmed = false;
    const s = settings.value;
    if (!s.autoHide || island.expanded) return;
    autoHideArmed = true;
    autoHideTimer = window.setTimeout(() => {
      autoHideArmed = false;
      if (island.expanded || root.matches(":hover")) {
        scheduleAutoHide();
        return;
      }
      void isExceptedApp().then((excepted) => {
        if (excepted) {
          scheduleAutoHide();
          return;
        }
        void api.hide().catch(() => undefined);
      });
    }, Math.max(3000, s.autoHideDelayMs));
  };

  const island = new Island(root, panel, settings, {
    onExpandChange: (expanded) => {
      window.clearTimeout(autoHideTimer);
      if (expanded) {
        manager.resume();
      } else {
        manager.suspend();
        scheduleAutoHide();
      }
    },
  });

  const alarms = new AlarmCenter(alarmHost, settings, {
    expand: () => island.expand(),
    show: () => {
      if (api.available) void api.show().catch(() => undefined);
    },
    requestResize: () => island.requestResize(),
    hold: (held) => island.hold(held),
  });

  const manager = new WidgetManager(widgetDefs, host, tabs, pillMinis, settings, {
    expand: (widgetId) => {
      if (widgetId) manager.setActive(widgetId);
      island.expand();
    },
    collapse: () => island.collapse(),
    requestResize: () => island.requestResize(),
    toast,
    // The timer uses the same notification sound as a reminder, synthesised on
    // the shared audio graph instead of creating a new AudioContext per beep.
    chime: () => {
      const s = settings.value;
      void playSound(s.reminderSound, s.reminderVolume);
    },
    alarm: (item) => alarms.trigger(item),
    onWidgetsChanged: (enabled, order) => {
      void emit("island://widgets-changed", { enabled, order }).catch(() => undefined);
    },
  });
  bridge.manager = manager;
  bridge.hold = (held) => island.hold(held);
  await manager.init();

  if (import.meta.env.DEV) {
    (window as unknown as { __island: unknown }).__island = {
      expand: () => island.expand(),
      collapse: () => island.collapse(),
      manager,
      settings,
      api,
      shelf: shelfBridge,
      alarms,
      escape: { push: pushEscapeLayer, count: escapeLayerCount },
    };
  }

  // --- clock -------------------------------------------------------------
  // WebView2 unlocks WebAudio only after a real user gesture: do it on the
  // first one so a later alarm can synthesise its sound instead of falling
  // back to the system beep.
  window.addEventListener("pointerdown", primeAudio, { passive: true });
  window.addEventListener("keydown", primeAudio, { passive: true });

  const renderClock = (): void => {
    const now = new Date();
    clock.textContent = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    clock.style.display = settings.value.showClock ? "" : "none";
  };
  renderClock();
  window.setInterval(renderClock, CLOCK_INTERVAL);
  settings.subscribe(renderClock);

  // --- auto hide ---------------------------------------------------------
  for (const evt of ["mousemove", "mousedown", "wheel"] as const) {
    document.addEventListener(evt, scheduleAutoHide, { passive: true });
  }
  settings.subscribe(() => scheduleAutoHide());
  scheduleAutoHide();
  // Safety net: arm the countdown only when it is not running, e.g. after the
  // island was hidden by the hotkey or the tray and is shown again.
  window.setInterval(() => {
    if (autoHideArmed) return;
    scheduleAutoHide();
  }, AUTO_HIDE_CHECK);

  // --- drag the pill along the top edge ---------------------------------
  if (api.available) {
    const pointerDrag = async (event: MouseEvent): Promise<void> => {
      if (event.button !== 0 || settings.value.pinnedPosition) return;
      const target = event.target as HTMLElement;
      if (target.closest("button")) return;
      try {
        await getCurrentWindow().startDragging();
      } catch (err) {
        console.warn("drag failed", err);
      }
    };
    document.getElementById("pill")?.addEventListener("mousedown", (event) => {
      // A 6px line is a hover/click target, not a drag handle.
      if (!island.expanded && settings.value.collapsedMode === "line") return;
      void pointerDrag(event);
    });

    const win = getCurrentWindow();
    let moveTimer: number | undefined;
    let applying = false;
    await win.onMoved(() => {
      if (applying || settings.value.pinnedPosition) return;
      window.clearTimeout(moveTimer);
      moveTimer = window.setTimeout(async () => {
        try {
          const [pos, size, monitors] = await Promise.all([
            win.outerPosition(),
            win.outerSize(),
            api.monitors(),
          ]);
          const cx = pos.x + size.width / 2;
          const cy = pos.y + size.height / 2;
          const monitor = monitors.find(
            (m) => cx >= m.x && cx < m.x + m.width && cy >= m.y && cy < m.y + m.height,
          );
          if (!monitor) return;
          const offset = Math.round((cx - (monitor.x + monitor.width / 2)) / monitor.scale);
          applying = true;
          await api.drift(offset);
        } catch (err) {
          console.warn("drift failed", err);
        } finally {
          window.setTimeout(() => {
            applying = false;
          }, 160);
        }
      }, 260);
    });

    // --- hotkeys from the Rust side -------------------------------------
    await listen("island://open-settings", () => {
      manager.setActive("settings");
      island.expand();
    });

    // --- settings window sync -------------------------------------------
    await listen<typeof settings.value>("island://settings-changed", (event) => {
      settings.replace(event.payload);
    });

    await listen<{ enabled: string[]; order?: string[] }>(
      "island://widgets-changed",
      (event) => {
        const ids = event.payload?.enabled;
        if (!Array.isArray(ids)) return;
        const order = Array.isArray(event.payload?.order) ? event.payload.order : [];
        const changed =
          ids.join("|") !== manager.enabledIds.join("|") ||
          order.join("|") !== manager.orderIds.join("|");
        manager.setOrder(order);
        manager.setEnabledIds(ids);
        // A local reorder already repaints its own list; an event from the
        // other window must always repaint, even when our state matched.
        if (changed || Array.isArray(event.payload?.order)) bridge.refresh?.();
      },
    );

    await listen("island://widgets-request", () => {
      void emit("island://widgets-changed", {
        enabled: manager.enabledIds,
        order: manager.orderIds,
      }).catch(() => undefined);
    });

    // --- display / DPI / resume ------------------------------------------
    // The native watcher notices that the monitor the island sits on changed
    // (undock, sleep, Windows scaling) and asks us to re-measure.
    await listen("island://display-changed", () => island.refresh());

    // The standalone settings window can expand or collapse the island.
    await listen<boolean>("island://expanded", (event) => {
      if (event.payload) island.expand();
      else island.collapse();
    });
    void getCurrentWindow()
      .onScaleChanged(() => island.refresh())
      .catch(() => undefined);

    // --- native file drag & drop into the shelf --------------------------
    await getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === "enter") {
        manager.setActive("shelf");
        // While a file hovers over the island the user is still holding the
        // left button: the panel must not collapse under the cursor.
        island.hold(true);
        island.expand();
        shelfBridge.highlight?.(true);
      } else if (payload.type === "drop") {
        shelfBridge.highlight?.(false);
        island.hold(false);
        shelfBridge.add?.(payload.paths);
        window.clearTimeout(dropCloseTimer);
        dropCloseTimer = window.setTimeout(() => {
          if (!root.matches(":hover")) island.collapse();
        }, 1600);
      } else if (payload.type === "leave") {
        shelfBridge.highlight?.(false);
        island.hold(false);
        // The drag was cancelled: close again unless the cursor stayed on us.
        window.clearTimeout(dropCloseTimer);
        dropCloseTimer = window.setTimeout(() => {
          if (!root.matches(":hover")) island.collapse();
        }, 600);
      }
    });
  }
}

/**
 * Frontend errors go to the same `data/logs/win-island.log` as the native
 * ones: a white window or a dead widget is otherwise impossible to explain.
 */
function reportError(scope: string, err: unknown): void {
  const message =
    err instanceof Error
      ? `${err.message}${err.stack ? `\n${err.stack}` : ""}`
      : String(err);
  console.error(`[${scope}]`, err);
  if (api.available) void api.logEvent(scope, message).catch(() => undefined);
}

window.addEventListener("error", (event) => {
  reportError("window", event.error ?? event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  reportError("promise", event.reason);
});

window.addEventListener("DOMContentLoaded", () => {
  // The settings window loads the same bundle; its window label tells it apart.
  const isSettingsWindow = getCurrentWindow().label === "settings";
  const boot = isSettingsWindow ? bootstrapSettingsWindow : bootstrap;
  void boot().catch((err) => {
    reportError("boot", err);
    showFatal(err);
  });
});

/**
 * Last-resort error surface: a failed boot used to leave a blank white window
 * with invisible white text, which is impossible to diagnose.
 */
function showFatal(err: unknown): void {
  const message = err instanceof Error ? `${err.message}\n\n${err.stack ?? ""}` : String(err);
  const panel = document.createElement("pre");
  panel.style.cssText = [
    "position:fixed",
    "inset:0",
    "margin:0",
    "padding:18px",
    "background:#141419",
    "color:#ffd7d7",
    "font:12px/1.5 ui-monospace,Consolas,monospace",
    "white-space:pre-wrap",
    "overflow:auto",
    "z-index:9999",
  ].join(";");
  panel.textContent = `Не удалось запустить интерфейс:\n\n${message}`;
  document.body.replaceChildren(panel);
}
