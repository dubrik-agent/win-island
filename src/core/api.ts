import { invoke } from "@tauri-apps/api/core";

export interface Settings {
  theme: "glass" | "dark" | "light" | "midnight" | "sand";
  accent: string;
  opacity: number;
  scale: number;
  animations: boolean;
  animationMs: number;
  /** Soft drop shadow around the island; off means the window is cut exactly. */
  shadow: boolean;

  collapsedMode: "line" | "pill";
  lineWidth: number;
  lineHeight: number;
  pillWidth: number;
  pillHeight: number;
  panelWidth: number;
  panelRadius: number;

  pinnedPosition: boolean;
  offsetX: number;
  topOffset: number;
  monitorMode: "primary" | "active" | "fixed";
  monitorIndex: number;
  monitorFollow: boolean;

  expandTrigger: "hover" | "click" | "both";
  hoverDelayMs: number;
  showClock: boolean;
  showMiniWidgets: boolean;
  autoHide: boolean;
  autoHideDelayMs: number;
  hideInFullscreen: boolean;
  hideOnMaximized: boolean;
  /** Process names (no `.exe`) that never trigger auto-hide. */
  autoHideExceptions: string[];

  reminderSound: "chime" | "bell" | "pop" | "alarm" | "none";
  reminderVolume: number;
  reminderAlarm: boolean;

  sysCpu: boolean;
  sysRam: boolean;
  sysDisks: boolean;
  sysUptime: boolean;

  /** "list" — rows with icons, "grid" — thumbnails for photos and videos. */
  shelfView: "list" | "grid";

  /** Interface sounds (expand, tab switch, drop, timer). */
  uiSounds: boolean;
  uiSoundVolume: number;

  hotkeyToggle: string;
  hotkeyHide: string;
  hotkeySettings: string;

  experimentalWidgets: boolean;
  widgetDir: string;
}

export interface DiskStats {
  name: string;
  total: number;
  free: number;
}

export interface SystemStats {
  cpu: number;
  ramUsed: number;
  ramTotal: number;
  uptimeSecs: number;
}

export interface HotkeyStatus {
  /** `null` when the combination is registered, otherwise the OS error. */
  toggle: string | null;
  hide: string | null;
  settings: string | null;
}

export interface MonitorInfo {
  index: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isPrimary: boolean;
  scale: number;
}

export interface MediaSource {
  id: string;
  app: string;
  title: string;
  playing: boolean;
}

export interface MediaSnapshot {
  active: boolean;
  app: string;
  appId: string;
  title: string;
  artist: string;
  album: string;
  playing: boolean;
  canNext: boolean;
  canPrev: boolean;
  canSeek: boolean;
  positionMs: number;
  durationMs: number;
  artKey: string;
  sources: MediaSource[];
}

/** Per-app level from the Windows audio mixer. */
export interface MediaVolume {
  level: number;
  muted: boolean;
}

export interface PathInfo {
  path: string;
  name: string;
  ext: string;
  isDir: boolean;
  size: number;
}

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) {
    throw new Error("not running inside Tauri");
  }
  return invoke<T>(cmd, args);
}

export const api = {
  available: isTauri,
  getSettings: () => call<Settings>("get_settings"),
  saveSettings: (settings: Settings) => call<void>("save_settings", { settings }),
  openSettingsWindow: () => call<void>("open_settings_window"),
  setBounds: (width: number, height: number) => call<void>("set_island_bounds", { width, height }),
  setHitRect: (x: number, y: number, width: number, height: number, radius: number) =>
    call<void>("set_hit_rect", { x, y, width, height, radius }),
  setIslandExpanded: (expanded: boolean) =>
    call<void>("set_island_expanded", { expanded }),
  drift: (offsetX: number) => call<void>("drift_island", { offsetX }),
  stats: () => call<SystemStats>("get_system_stats"),
  disks: () => call<DiskStats[]>("get_disk_stats"),
  beep: () => call<void>("beep"),
  monitors: () => call<MonitorInfo[]>("list_monitors"),
  hotkeyStatus: () => call<HotkeyStatus>("hotkey_status"),
  openData: () => call<void>("open_data_dir"),
  openLogs: () => call<void>("open_logs_dir"),
  logEvent: (scope: string, message: string) => call<void>("log_event", { scope, message }),
  hide: () => call<void>("hide_island_cmd"),
  show: () => call<void>("show_island_cmd"),
  foregroundApp: () =>
    call<{ process: string; title: string } | null>("foreground_app"),
  mediaState: () => call<MediaSnapshot>("media_state"),
  mediaArt: () => call<string | null>("media_art"),
  mediaControl: (action: "toggle" | "next" | "prev" | "seek", positionMs?: number) =>
    call<void>("media_control", { action, positionMs: positionMs ?? null }),
  mediaSelect: (appId: string) => call<void>("media_select", { appId }),
  mediaControlSource: (appId: string, action: "toggle" | "next" | "prev") =>
    call<void>("media_control_source", { appId, action }),
  mediaVolume: (appId: string) => call<MediaVolume | null>("media_volume", { appId }),
  mediaSetVolume: (appId: string, level: number) =>
    call<void>("media_set_volume", { appId, level }),
  mediaSetMute: (appId: string, muted: boolean) =>
    call<void>("media_set_mute", { appId, muted }),
  copyFiles: (paths: string[]) => call<void>("copy_files", { paths }),
  copyText: (text: string) => call<void>("copy_text", { text }),
  clipboardFiles: () => call<string[]>("clipboard_files"),
  openPath: (path: string) => call<void>("open_path", { path }),
  revealPath: (path: string) => call<void>("reveal_path", { path }),
  /** Native Explorer drag-out for a shelf file (blocks until dropped). */
  startFileDrag: (path: string) => call<void>("start_file_drag", { path }),
  describePaths: (paths: string[]) => call<PathInfo[]>("describe_paths", { paths }),
  quit: () => call<void>("quit_app"),
  async readStore<T>(name: string): Promise<T | null> {
    try {
      const raw = await call<string | null>("read_store", { name });
      if (!raw) return null;
      return JSON.parse(raw) as T;
    } catch (err) {
      // The native side already falls back to `<name>.json.bak`; reaching this
      // point means both copies are unreadable. Say so instead of silently
      // starting from scratch.
      console.warn("store read failed", name, err);
      void api.logEvent("store", `read failed for ${name}: ${String(err)}`).catch(() => undefined);
      return null;
    }
  },
  async writeStore(name: string, value: unknown): Promise<void> {
    try {
      await call<void>("write_store", { name, contents: JSON.stringify(value) });
    } catch (err) {
      console.warn("store write failed", name, err);
      void api.logEvent("store", `write failed for ${name}: ${String(err)}`).catch(() => undefined);
    }
  },
};
