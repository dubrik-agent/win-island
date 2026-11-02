import { api, type Settings } from "./api";

export const DEFAULT_SETTINGS: Settings = {
  theme: "glass",
  accent: "#7c9cff",
  opacity: 0.9,
  scale: 1,
  animations: true,
  animationMs: 460,
  shadow: true,

  collapsedMode: "line",
  lineWidth: 148,
  lineHeight: 6,
  pillWidth: 234,
  pillHeight: 36,
  panelWidth: 452,
  panelRadius: 26,

  pinnedPosition: false,
  offsetX: 0,
  topOffset: 6,
  monitorMode: "primary",
  monitorIndex: 0,
  monitorFollow: true,

  expandTrigger: "hover",
  hoverDelayMs: 90,
  showClock: true,
  showMiniWidgets: true,
  autoHide: false,
  autoHideDelayMs: 8000,
  hideInFullscreen: true,
  hideOnMaximized: false,
  autoHideExceptions: [],

  reminderSound: "chime",
  reminderVolume: 0.7,
  reminderAlarm: true,

  sysCpu: true,
  sysRam: true,
  sysDisks: true,
  sysUptime: false,

  shelfView: "list",

  uiSounds: true,
  uiSoundVolume: 0.5,

  hotkeyToggle: "Ctrl+Alt+Space",
  hotkeyHide: "Ctrl+Alt+H",
  hotkeySettings: "Ctrl+Alt+S",

  experimentalWidgets: false,
  widgetDir: "",
};

type Listener = (settings: Settings) => void;

/** Small reactive store for settings; single source of truth for the UI. */
export class SettingsStore {
  value: Settings = { ...DEFAULT_SETTINGS };
  private listeners = new Set<Listener>();
  private saveTimer: number | undefined;

  async load(): Promise<void> {
    if (api.available) {
      try {
        this.value = { ...DEFAULT_SETTINGS, ...(await api.getSettings()) };
      } catch (err) {
        console.warn("settings load failed, using defaults", err);
      }
    }
    this.emit();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Update in memory immediately, persist with a short debounce. */
  patch(partial: Partial<Settings>): void {
    this.value = { ...this.value, ...partial };
    this.emit();
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = undefined;
      void api.saveSettings(this.value).catch((err) => console.warn("settings save failed", err));
    }, 140);
  }

  /** Apply settings that came from another window; never persists again. */
  replace(next: Settings): void {
    // Local edits that have not been persisted yet are always newer.
    if (this.saveTimer !== undefined) return;
    const merged = { ...DEFAULT_SETTINGS, ...next };
    if (JSON.stringify(merged) === JSON.stringify(this.value)) return;
    this.value = merged;
    this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.value);
  }
}
