//! Persistent settings for Win Island.
//! Stored as JSON next to the project/app data folder (`data/settings.json`).

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    // --- appearance ---
    pub theme: String,          // "glass" | "dark" | "light" | "midnight" | "sand"
    pub accent: String,         // hex color
    pub opacity: f64,           // 0.5 .. 1.0 (multiplier for theme surface)
    pub scale: f64,             // 0.8 .. 1.3
    pub animations: bool,
    pub animation_ms: u32,      // 120 .. 800
    /// Soft drop shadow around the island. Off means the window is cut exactly
    /// to the island, so nothing invisible sits next to it.
    pub shadow: bool,

    // --- shape ---
    pub collapsed_mode: String, // "line" (тонкая полоска) | "pill" (пилюля с часами)
    pub line_width: f64,        // 60 .. 320
    pub line_height: f64,       // 3 .. 18
    pub pill_width: f64,        // 200 .. 340 (и ширина шапки при раскрытии)
    pub pill_height: f64,       // 26 .. 48 (высота шапки)
    pub panel_width: f64,       // 360 .. 620
    pub panel_radius: f64,      // 0 .. 36

    // --- placement ---
    pub pinned_position: bool,  // false => pill can be dragged
    pub offset_x: f64,          // logical px from center
    pub top_offset: f64,        // logical px from top of the work area
    pub monitor_mode: String,   // "primary" | "active" | "fixed"
    pub monitor_index: usize,
    pub monitor_follow: bool,   // follow active window across monitors

    // --- behaviour ---
    pub expand_trigger: String, // "hover" | "click" | "both"
    pub hover_delay_ms: u32,
    pub show_clock: bool,
    pub show_mini_widgets: bool,
    pub auto_hide: bool,
    pub auto_hide_delay_ms: u32,
    pub hide_in_fullscreen: bool,
    pub hide_on_maximized: bool,
    /// Process names (without `.exe`) that never trigger the auto-hide.
    pub auto_hide_exceptions: Vec<String>,
    pub start_with_windows: bool,

    // --- widget: reminders ---
    pub reminder_sound: String, // "chime" | "bell" | "pop" | "alarm" | "none"
    pub reminder_volume: f64,   // 0.0 .. 1.0
    pub reminder_alarm: bool,   // keep ringing until the user stops it

    // --- widget: system monitor ---
    pub sys_cpu: bool,
    pub sys_ram: bool,
    pub sys_disks: bool,
    pub sys_uptime: bool,

    // --- widget: shelf ---
    pub shelf_view: String, // "list" | "grid" (thumbnails)

    // --- sound ---
    /// Soft interface sounds: expand/collapse, tab switch, drop.
    pub ui_sounds: bool,
    pub ui_sound_volume: f64,

    // --- hotkeys ---
    pub hotkey_toggle: String,
    pub hotkey_hide: String,
    pub hotkey_settings: String,

    // --- experimental ---
    pub experimental_widgets: bool,
    pub widget_dir: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "glass".into(),
            accent: "#7c9cff".into(),
            opacity: 0.9,
            scale: 1.0,
            animations: true,
            animation_ms: 460,
            shadow: true,

            collapsed_mode: "line".into(),
            line_width: 148.0,
            line_height: 6.0,
            pill_width: 234.0,
            pill_height: 36.0,
            panel_width: 452.0,
            panel_radius: 26.0,

            pinned_position: false,
            offset_x: 0.0,
            top_offset: 6.0,
            monitor_mode: "primary".into(),
            monitor_index: 0,
            monitor_follow: true,

            expand_trigger: "hover".into(),
            hover_delay_ms: 90,
            show_clock: true,
            show_mini_widgets: true,
            auto_hide: false,
            auto_hide_delay_ms: 8000,
            hide_in_fullscreen: true,
            hide_on_maximized: false,
            auto_hide_exceptions: Vec::new(),
            start_with_windows: false,

            reminder_sound: "chime".into(),
            reminder_volume: 0.7,
            reminder_alarm: true,

            sys_cpu: true,
            sys_ram: true,
            sys_disks: true,
            sys_uptime: false,

            shelf_view: "list".into(),

            ui_sounds: true,
            ui_sound_volume: 0.5,

            hotkey_toggle: "Ctrl+Alt+Space".into(),
            hotkey_hide: "Ctrl+Alt+H".into(),
            hotkey_settings: "Ctrl+Alt+S".into(),

            experimental_widgets: false,
            widget_dir: String::new(),
        }
    }
}

pub fn data_dir() -> PathBuf {
    if let Ok(custom) = std::env::var("WINISLAND_DATA") {
        return PathBuf::from(custom);
    }
    // Dev builds keep data inside the project, release builds next to the exe.
    if cfg!(debug_assertions) {
        return PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(|p| p.join("data"))
            .unwrap_or_else(|| PathBuf::from("data"));
    }
    // Release: portable folder next to the exe when writable, otherwise a
    // per-user folder (e.g. exe installed into Program Files).
    DATA_DIR
        .get_or_init(|| {
            let portable = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|p| p.join("data")));
            if let Some(dir) = portable {
                if is_writable(&dir) {
                    return dir;
                }
            }
            std::env::var("LOCALAPPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(|_| PathBuf::from("."))
                .join("WinIsland")
                .join("data")
        })
        .clone()
}

static DATA_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// A directory is usable if it already exists or can be created, plus we can
/// write into it. Checked once per process.
fn is_writable(dir: &std::path::Path) -> bool {
    if fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".write-probe");
    let ok = fs::write(&probe, b"ok").is_ok();
    let _ = fs::remove_file(&probe);
    ok
}

fn settings_path() -> PathBuf {
    data_dir().join("settings.json")
}

/// Sidecar copy of the previous good file. Written by the same rename dance as
/// the target, so it is always a complete document.
pub fn backup_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".bak");
    path.with_file_name(name)
}

fn temp_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".tmp");
    path.with_file_name(name)
}

/// Replace `path` without ever leaving a half-written file behind: the new
/// contents go to a temp file (flushed to disk), the old file is moved to
/// `.bak`, and only then does the temp file take its place. A power cut at any
/// point leaves either the old document, the new one, or both — never a
/// truncated one. `std::fs::rename` maps to `MoveFileExW(REPLACE_EXISTING)` on
/// Windows, so the final step is atomic.
pub fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = temp_path(path);
    {
        let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        file.write_all(contents.as_bytes()).map_err(|e| e.to_string())?;
        // Without this the rename can win the race against the data itself.
        file.sync_all().map_err(|e| e.to_string())?;
    }
    let bak = backup_path(path);
    let had_old = path.exists();
    if had_old {
        let _ = fs::remove_file(&bak);
        fs::rename(path, &bak).map_err(|e| e.to_string())?;
    }
    if let Err(err) = fs::rename(&tmp, path) {
        // Put the previous document back so the app keeps working.
        if had_old {
            let _ = fs::rename(&bak, path);
        }
        let _ = fs::remove_file(&tmp);
        return Err(err.to_string());
    }
    Ok(())
}

/// Read a JSON document, falling back to its `.bak` when the main file is
/// missing or damaged (external editor, disk error, interrupted copy).
pub fn read_store_file(path: &Path) -> Option<String> {
    let bak = backup_path(path);
    if let Ok(raw) = fs::read_to_string(path) {
        if serde_json::from_str::<serde_json::Value>(raw.trim_start_matches('\u{feff}')).is_ok() {
            return Some(raw);
        }
        crate::logging::write("store", format!("{} is damaged, trying .bak", path.display()));
    }
    fs::read_to_string(&bak).ok()
}

impl Settings {
    pub fn load() -> Self {
        let path = settings_path();
        match read_store_file(&path) {
            // Notepad and a few editors prepend a UTF-8 BOM, and serde rejects
            // it: the app would silently fall back to defaults and lose the
            // user's theme, monitor and hotkeys.
            Some(raw) => match serde_json::from_str::<Settings>(raw.trim_start_matches('\u{feff}')) {
                Ok(settings) => settings,
                Err(e) => {
                    // A corrupt settings file must be visible in the log, not
                    // lost in a console nobody sees in a release build.
                    crate::logging::write("settings", format!("parse error: {e}; using defaults"));
                    Settings::default()
                }
            },
            None => Settings::default(),
        }
    }

    pub fn save(&self) -> Result<(), String> {
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        write_atomic(&settings_path(), &json)
    }
}
