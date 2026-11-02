mod audio;
mod dragdrop;
mod logging;
mod media;
mod settings;
mod winapi_ext;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use settings::{data_dir, Settings};
use winapi_ext::{CpuSampler, ForegroundState};

/// `Mutex::lock()` returns `Err` forever once any thread panicked while holding
/// the lock, so a single one-off bug would turn every later command into a
/// second panic — the window stays open but stops reacting. Recovering the
/// inner value keeps the app usable instead.
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct IslandState {
    settings: Mutex<Settings>,
    /// true when the user hid the island manually (hotkey / tray)
    manual_hidden: AtomicBool,
    /// true when the island was hidden automatically (fullscreen / maximized window)
    auto_hidden: AtomicBool,
    /// last logical size requested by the frontend
    size: Mutex<(f64, f64)>,
    cpu: Mutex<CpuSampler>,
}

#[derive(Clone)]
struct Hotkeys {
    toggle: Shortcut,
    hide: Shortcut,
    settings: Shortcut,
}

/// Registration outcome for one shortcut: `None` = registered, `Some(text)` =
/// the exact reason Windows refused it (usually another app owns the combo).
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct HotkeyStatus {
    toggle: Option<String>,
    hide: Option<String>,
    settings: Option<String>,
}

/// Registered shortcuts + their status. Both live behind one lock because the
/// settings window can rebind keys at any moment while the handler is running.
#[derive(Default)]
struct HotkeyRegistry {
    current: std::sync::Mutex<Option<Hotkeys>>,
    status: std::sync::Mutex<HotkeyStatus>,
}

impl HotkeyRegistry {
    fn snapshot(&self) -> Option<Hotkeys> {
        self.current.lock().ok().and_then(|guard| guard.clone())
    }
}

fn parse_shortcut(raw: &str, fallback: Shortcut) -> Shortcut {
    raw.parse::<Shortcut>().unwrap_or(fallback)
}

fn build_hotkeys(s: &Settings) -> Hotkeys {
    Hotkeys {
        toggle: parse_shortcut(
            &s.hotkey_toggle,
            Shortcut::new(
                Some(
                    tauri_plugin_global_shortcut::Modifiers::CONTROL
                        | tauri_plugin_global_shortcut::Modifiers::ALT,
                ),
                tauri_plugin_global_shortcut::Code::Space,
            ),
        ),
        hide: parse_shortcut(
            &s.hotkey_hide,
            Shortcut::new(
                Some(
                    tauri_plugin_global_shortcut::Modifiers::CONTROL
                        | tauri_plugin_global_shortcut::Modifiers::ALT,
                ),
                tauri_plugin_global_shortcut::Code::KeyH,
            ),
        ),
        settings: parse_shortcut(
            &s.hotkey_settings,
            Shortcut::new(
                Some(
                    tauri_plugin_global_shortcut::Modifiers::CONTROL
                        | tauri_plugin_global_shortcut::Modifiers::ALT,
                ),
                tauri_plugin_global_shortcut::Code::KeyS,
            ),
        ),
    }
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

/// (Re)registers every global shortcut from `settings`.
///
/// Errors used to be discarded with `let _ =`, so an occupied combo simply did
/// nothing and there was no way to notice. Now each failure is logged and handed
/// to the UI, where the matching field shows it.
fn install_hotkeys(app: &AppHandle, settings: &Settings) -> HotkeyStatus {
    let hotkeys = build_hotkeys(settings);
    let manager = app.global_shortcut();
    let _ = manager.unregister_all();

    let mut status = HotkeyStatus::default();
    let entries: [(&Shortcut, &str, &str); 3] = [
        (&hotkeys.toggle, "toggle", &settings.hotkey_toggle),
        (&hotkeys.hide, "hide", &settings.hotkey_hide),
        (&hotkeys.settings, "settings", &settings.hotkey_settings),
    ];
    for (shortcut, action, raw) in entries {
        let result = manager.register(*shortcut);
        let error = result.err().map(|err| err.to_string());
        match &error {
            None => logln!("hotkeys", "{action}: registered {raw} (id {})", shortcut.id()),
            Some(message) => logln!("hotkeys", "{action}: FAILED {raw} ({message})"),
        }
        match action {
            "toggle" => status.toggle = error,
            "hide" => status.hide = error,
            _ => status.settings = error,
        }
    }

    if let Some(registry) = app.try_state::<HotkeyRegistry>() {
        if let Ok(mut guard) = registry.current.lock() {
            *guard = Some(hotkeys);
        }
        if let Ok(mut guard) = registry.status.lock() {
            *guard = status.clone();
        }
    }
    let _ = app.emit("island://hotkeys-status", status.clone());
    status
}

#[tauri::command]
fn hotkey_status(app: AppHandle) -> HotkeyStatus {
    app.try_state::<HotkeyRegistry>()
        .and_then(|registry| registry.status.lock().ok().map(|guard| guard.clone()))
        .unwrap_or_default()
}

fn show_island(app: &AppHandle) {
    if let Some(state) = app.try_state::<IslandState>() {
        state.manual_hidden.store(false, Ordering::SeqCst);
        state.auto_hidden.store(false, Ordering::SeqCst);
        let s = lock(&state.settings).clone();
        let (w, h) = *lock(&state.size);
        if let Some(win) = main_window(app) {
            apply_island_bounds(&win, &s, w, h);
            set_visible_raw(&win, true);
        }
        return;
    }
    if let Some(win) = main_window(app) {
        set_visible_raw(&win, true);
    }
}

/// Shows/hides the island through raw Win32 calls.
///
/// `WebviewWindow::show()` activates the window (the hotkey would yank focus
/// out of the user's editor) and both `show()`/`hide()` keep a cached
/// visibility flag that raw `ShowWindow` never updates. Mixing them makes the
/// second `hide()` a no-op, so every visibility change goes through here.
fn set_visible_raw(win: &WebviewWindow, visible: bool) {
    match win.hwnd() {
        Ok(hwnd) => {
            if visible {
                winapi_ext::show_no_activate(hwnd.0 as isize);
            } else {
                winapi_ext::hide_window(hwnd.0 as isize);
            }
        }
        Err(err) => {
            logln!("island", "no hwnd for visibility change: {err}");
            let _ = if visible { win.show() } else { win.hide() };
        }
    }
}

fn hide_island_manual(app: &AppHandle) {
    if let Some(state) = app.try_state::<IslandState>() {
        state.manual_hidden.store(true, Ordering::SeqCst);
    }
    if let Some(win) = main_window(app) {
        set_visible_raw(&win, false);
    }
}

fn toggle_island(app: &AppHandle) {
    let hidden = app
        .try_state::<IslandState>()
        .map(|s| s.manual_hidden.load(Ordering::SeqCst))
        .unwrap_or(false);
    if hidden {
        show_island(app);
    } else {
        hide_island_manual(app);
    }
}

fn target_monitor(window: &WebviewWindow, s: &Settings) -> Option<tauri::Monitor> {
    let monitors = window.available_monitors().ok()?;
    match s.monitor_mode.as_str() {
        "active" => {
            if let Some(fg) = winapi_ext::foreground_monitor_rect() {
                monitors
                    .iter()
                    .find(|m| {
                        let p = m.position();
                        (p.x - fg.left).abs() <= 2 && (p.y - fg.top).abs() <= 2
                    })
                    .cloned()
            } else {
                window.primary_monitor().ok().flatten()
            }
        }
        "fixed" => monitors
            .get(s.monitor_index)
            .cloned()
            .or_else(|| window.primary_monitor().ok().flatten()),
        _ => window.primary_monitor().ok().flatten(),
    }
}

/// Logical size of the collapsed island (line or pill), before the UI scale
/// and the surrounding margin used for the drop shadow.
fn collapsed_logical_size(s: &Settings) -> (f64, f64) {
    if s.collapsed_mode == "line" {
        (s.line_width.max(40.0), s.line_height.max(3.0))
    } else {
        (s.pill_width.max(120.0), s.pill_height.max(20.0))
    }
}

fn apply_island_bounds(window: &WebviewWindow, s: &Settings, w: f64, h: f64) {
    let Some(monitor) = target_monitor(window, s) else {
        return;
    };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let phys_w = (w * scale).round().max(1.0) as u32;
    let phys_h = (h * scale).round().max(1.0) as u32;
    let center_x = area.position.x + (area.size.width as i32 - phys_w as i32) / 2;
    let x = center_x + (s.offset_x * scale).round() as i32;
    let y = area.position.y + (s.top_offset * scale).round() as i32;
    let _ = window.set_size(PhysicalSize::new(phys_w, phys_h));
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_settings(state: State<'_, IslandState>) -> Settings {
    lock(&state.settings).clone()
}

#[tauri::command]
fn save_settings(
    app: AppHandle,
    state: State<'_, IslandState>,
    settings: Settings,
) -> Result<(), String> {
    // Sliders patch settings on every tick: keep the expensive native work
    // (window move/resize, theme, global hotkeys) behind a real change check.
    let previous = {
        let mut guard = lock(&state.settings);
        std::mem::replace(&mut *guard, settings.clone())
    };
    settings.save()?;

    let placement_changed = previous.offset_x != settings.offset_x
        || previous.top_offset != settings.top_offset
        || previous.monitor_mode != settings.monitor_mode
        || previous.monitor_index != settings.monitor_index
        || previous.monitor_follow != settings.monitor_follow
        || previous.scale != settings.scale;
    if placement_changed {
        let (w, h) = *lock(&state.size);
        if let Some(win) = main_window(&app) {
            apply_island_bounds(&win, &settings, w, h);
        }
    }
    // Native window chrome (title bar) follows the app theme as well.
    if previous.theme != settings.theme {
        apply_window_theme(&app, &settings.theme);
    }
    // Rebind hotkeys only when a combination actually changed.
    let hotkeys_changed = previous.hotkey_toggle != settings.hotkey_toggle
        || previous.hotkey_hide != settings.hotkey_hide
        || previous.hotkey_settings != settings.hotkey_settings;
    if hotkeys_changed {
        install_hotkeys(&app, &settings);
    }
    // Both the island and the standalone settings window keep a copy of the
    // settings in memory; tell every window about the new values.
    let _ = app.emit("island://settings-changed", settings);
    Ok(())
}

fn theme_is_light(theme: &str) -> bool {
    matches!(theme, "light" | "sand")
}

/// Opaque surface color of a theme, used as the native window background so no
/// white frame flashes before the webview paints.
fn theme_surface(theme: &str) -> tauri::window::Color {
    match theme {
        "light" => tauri::window::Color(250, 250, 252, 255),
        "sand" => tauri::window::Color(243, 238, 228, 255),
        "midnight" => tauri::window::Color(11, 13, 22, 255),
        "dark" => tauri::window::Color(9, 9, 11, 255),
        _ => tauri::window::Color(10, 10, 12, 255),
    }
}

fn apply_window_theme(app: &AppHandle, theme: &str) {
    let native = if theme_is_light(theme) {
        tauri::Theme::Light
    } else {
        tauri::Theme::Dark
    };
    for label in ["main", "settings"] {
        if let Some(win) = app.get_webview_window(label) {
            let _ = win.set_theme(Some(native));
        }
    }
}

/// Opens (or focuses) the settings window. Keeping it a separate top-level
/// window lets the panel stay tiny while the user works through the options.
///
/// This is the only safe entry point: commands, the tray menu and the global
/// shortcut handler all run on the main thread, and a WebView2 window built
/// there never navigates — it stays at `about:blank`, so the user sees an empty
/// dark window. The actual work therefore happens on a worker thread.
fn open_settings(app: &AppHandle) -> Result<(), String> {
    // Two quick clicks would otherwise race and try to build the same label.
    static OPENING: AtomicBool = AtomicBool::new(false);
    if OPENING.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(err) = open_settings_blocking(&app) {
            logln!("settings", "open failed: {err}");
        }
        OPENING.store(false, Ordering::SeqCst);
    });
    Ok(())
}

fn open_settings_blocking(app: &AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    let theme = app
        .state::<IslandState>()
        .settings
        .lock()
        .map(|s| s.theme.clone())
        .unwrap_or_else(|_| "glass".into());

    // Centre the window on the monitor the island lives on. `.center()` always
    // uses the *primary* monitor, so on a two-screen setup the settings window
    // would pop up over whatever is happening on the other screen.
    let monitor = main_window(app).and_then(|win| {
        app.state::<IslandState>()
            .settings
            .lock()
            .ok()
            .map(|s| s.clone())
            .and_then(|s| target_monitor(&win, &s))
    });
    let (settings_w, settings_h) = (620.0_f64, 820.0_f64);
    let position = monitor.map(|monitor| {
        let scale = monitor.scale_factor();
        let area = monitor.work_area();
        let w = (settings_w * scale).min(area.size.width as f64);
        let h = (settings_h * scale).min(area.size.height as f64);
        let x = area.position.x as f64 + (area.size.width as f64 - w) / 2.0;
        let y = area.position.y as f64 + (area.size.height as f64 - h) / 2.0;
        (x / scale, y / scale)
    });

    let light = theme_is_light(&theme);
    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        "settings",
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("Win Island — Настройки")
    .inner_size(settings_w, settings_h)
    .min_inner_size(460.0, 520.0)
    .resizable(true)
    .theme(Some(if light {
        tauri::Theme::Light
    } else {
        tauri::Theme::Dark
    }))
    // Never flash white: the native surface already matches the theme.
    .background_color(theme_surface(&theme))
    // Never open taller/wider than the monitor: 620x820 does not fit a laptop
    // screen at 150 %, and the window then looks broken.
    .prevent_overflow_with_margin(tauri::LogicalSize::new(24.0, 48.0));
    match position {
        Some((x, y)) => builder = builder.position(x, y),
        None => builder = builder.center(),
    }

    // NOTE: a second WebView2 environment cannot reuse the island's devtools
    // port, so the settings window is inspected visually in dev.
    let win = builder.build().map_err(|err| format!("settings window: {err}"))?;
    // Navigation is asynchronous, so `url()` is still `about:blank` here; the
    // line only proves the window was actually built.
    logln!("settings", "window created");
    let _ = win.set_focus();
    Ok(())
}

#[tauri::command]
fn open_settings_window(app: AppHandle) -> Result<(), String> {
    open_settings(&app)
}

#[tauri::command]
fn set_island_bounds(
    app: AppHandle,
    state: State<'_, IslandState>,
    width: f64,
    height: f64,
) -> Result<(), String> {
    *lock(&state.size) = (width, height);
    let s = lock(&state.settings).clone();
    if let Some(win) = main_window(&app) {
        apply_island_bounds(&win, &s, width, height);
    }
    Ok(())
}

#[tauri::command]
fn drift_island(app: AppHandle, state: State<'_, IslandState>, offset_x: f64) -> Result<(), String> {
    let mut guard = lock(&state.settings);
    guard.offset_x = offset_x;
    let s = guard.clone();
    drop(guard);
    s.save()?;
    let (w, h) = *lock(&state.size);
    if let Some(win) = main_window(&app) {
        apply_island_bounds(&win, &s, w, h);
    }
    Ok(())
}

/// Island rectangle inside the webview (CSS px) plus its corner radius. The
/// native window is cut down to this rectangle, so the empty area around the
/// island never steals clicks from other apps.
#[tauri::command]
fn set_hit_rect(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    radius: f64,
) -> Result<(), String> {
    let Some(win) = main_window(&app) else {
        return Ok(());
    };
    let scale = win.scale_factor().unwrap_or(1.0);
    let rect = winapi_ext::Rect {
        left: (x * scale).round() as i32,
        top: (y * scale).round() as i32,
        right: ((x + width) * scale).round() as i32,
        bottom: ((y + height) * scale).round() as i32,
    };
    let radius = (radius * scale).round() as i32;
    let handle = win.clone();
    // Window regions must be changed on the thread that owns the window.
    let _ = win.run_on_main_thread(move || {
        if let Ok(hwnd) = handle.hwnd() {
            winapi_ext::apply_island_region(hwnd.0 as isize, rect, radius);
        }
    });
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiskStats {
    name: String,
    total: u64,
    free: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemStats {
    cpu: f32,
    ram_used: u64,
    ram_total: u64,
    /// Seconds since boot; the widget formats it as `2 д 4 ч 12 м`.
    uptime_secs: u64,
}

/// Cheap metrics only: no volume enumeration, safe to poll every second.
#[tauri::command]
fn get_system_stats(state: State<'_, IslandState>) -> SystemStats {
    let usage = {
        let mut cpu = lock(&state.cpu);
        cpu.usage()
    };
    let (used, total) = winapi_ext::memory_usage();
    SystemStats {
        cpu: usage,
        ram_used: used,
        ram_total: total,
        uptime_secs: winapi_ext::uptime_secs(),
    }
}

/// Touches every mounted volume, so it is polled far less often than the CPU.
#[tauri::command]
async fn get_disk_stats() -> Vec<DiskStats> {
    tauri::async_runtime::spawn_blocking(winapi_ext::disk_usage)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|disk| DiskStats {
            name: disk.name,
            total: disk.total,
            free: disk.free,
        })
        .collect()
}

#[tauri::command]
fn beep() {
    winapi_ext::beep(0x0000_0040); // MB_ICONASTERISK
}

// ---------------------------------------------------------------------------
// Now playing (SMTC). WinRT calls block while a player answers, so every
// command hops off the async runtime thread.
// ---------------------------------------------------------------------------

#[tauri::command]
async fn media_state() -> media::Snapshot {
    tauri::async_runtime::spawn_blocking(media::snapshot)
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn media_art() -> Option<String> {
    tauri::async_runtime::spawn_blocking(media::artwork)
        .await
        .ok()
        .flatten()
}

#[tauri::command]
async fn media_control(action: String, position_ms: Option<u64>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || media::control(&action, position_ms))
        .await
        .unwrap_or_else(|err| Err(err.to_string()))
}

#[tauri::command]
fn media_select(app_id: String) {
    media::select(&app_id);
}

/// Pause/play/skip one specific source without switching the active one.
#[tauri::command]
async fn media_control_source(app_id: String, action: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || media::control_source(&app_id, &action))
        .await
        .unwrap_or_else(|err| Err(err.to_string()))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VolumeInfo {
    level: u32,
    muted: bool,
}

#[tauri::command]
async fn media_volume(app_id: String) -> Option<VolumeInfo> {
    tauri::async_runtime::spawn_blocking(move || audio::volume(&app_id))
        .await
        .ok()
        .flatten()
        .map(|(level, muted)| VolumeInfo { level, muted })
}

#[tauri::command]
async fn media_set_volume(app_id: String, level: u32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || audio::set_volume(&app_id, level))
        .await
        .unwrap_or_else(|err| Err(err.to_string()))
}

#[tauri::command]
async fn media_set_mute(app_id: String, muted: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || audio::set_mute(&app_id, muted))
        .await
        .unwrap_or_else(|err| Err(err.to_string()))
}

// ---------------------------------------------------------------------------
// File shelf: clipboard file lists, shell open/reveal, file metadata.
// ---------------------------------------------------------------------------

#[tauri::command]
fn copy_files(paths: Vec<String>) -> Result<(), String> {
    winapi_ext::copy_paths_to_clipboard(&paths)
}

#[tauri::command]
fn clipboard_files() -> Vec<String> {
    winapi_ext::clipboard_files()
}

#[tauri::command]
fn copy_text(text: String) -> Result<(), String> {
    winapi_ext::copy_text_to_clipboard(&text)
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    if winapi_ext::open_path(&path) {
        Ok(())
    } else {
        Err("не удалось открыть файл".to_string())
    }
}

#[tauri::command]
async fn reveal_path(path: String) -> Result<(), String> {
    // The shell call initializes COM and talks to Explorer, so it must not run
    // on the main thread.
    tauri::async_runtime::spawn_blocking(move || winapi_ext::reveal_in_folder(&path))
        .await
        .map_err(|err| err.to_string())?
}

/// Starts a real Explorer drag for a shelf file. Blocks until the drop, so it
/// lives on a worker thread.
#[tauri::command]
async fn start_file_drag(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || dragdrop::start_drag(&path))
        .await
        .map_err(|err| err.to_string())?
}

/// Lets the standalone settings window drive the island ("Развернуть" /
/// "Свернуть"). The island lives in another webview, so this is an event.
#[tauri::command]
fn set_island_expanded(app: AppHandle, expanded: bool) -> Result<(), String> {
    if expanded {
        let _ = show_island(&app);
    }
    app.emit_to("main", "island://expanded", expanded)
        .map_err(|err| err.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PathInfo {
    path: String,
    name: String,
    ext: String,
    is_dir: bool,
    size: u64,
}

#[tauri::command]
fn describe_paths(paths: Vec<String>) -> Vec<PathInfo> {
    paths
        .into_iter()
        .filter_map(|path| {
            let p = std::path::Path::new(&path);
            if !p.exists() {
                return None;
            }
            let meta = std::fs::metadata(p).ok()?;
            let name = p
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| path.clone());
            let ext = p
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            Some(PathInfo {
                path,
                name,
                ext,
                is_dir: meta.is_dir(),
                size: if meta.is_dir() { 0 } else { meta.len() },
            })
        })
        .collect()
}

#[tauri::command]
fn read_store(name: String) -> Option<String> {
    let safe = sanitize_name(&name)?;
    let path = data_dir().join("store").join(format!("{safe}.json"));
    if !path.exists() {
        return None;
    }
    settings::read_store_file(&path)
}

#[tauri::command]
fn write_store(name: String, contents: String) -> Result<(), String> {
    let safe = sanitize_name(&name).ok_or_else(|| "bad store name".to_string())?;
    let path = data_dir().join("store").join(format!("{safe}.json"));
    settings::write_atomic(&path, &contents)
}

fn sanitize_name(name: &str) -> Option<String> {
    if name.is_empty() || name.len() > 64 {
        return None;
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return None;
    }
    Some(name.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MonitorInfoDto {
    index: usize,
    name: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    is_primary: bool,
    scale: f64,
}

#[tauri::command]
fn list_monitors(app: AppHandle) -> Vec<MonitorInfoDto> {
    let Some(win) = main_window(&app) else {
        return vec![];
    };
    let primary = win.primary_monitor().ok().flatten();
    let primary_pos = primary.as_ref().map(|m| *m.position());
    let Ok(monitors) = win.available_monitors() else {
        return vec![];
    };
    monitors
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let p = m.position();
            let sz = m.size();
            let raw_name = m.name().cloned().unwrap_or_default();
            let name = if raw_name.is_empty() || raw_name.starts_with("\\\\") {
                format!("Монитор {}", i + 1)
            } else {
                raw_name
            };
            MonitorInfoDto {
                index: i,
                name,
                x: p.x,
                y: p.y,
                width: sz.width,
                height: sz.height,
                is_primary: primary_pos.map(|pp| pp.x == p.x && pp.y == p.y).unwrap_or(i == 0),
                scale: m.scale_factor(),
            }
        })
        .collect()
}

#[tauri::command]
fn open_data_dir() {
    let dir = data_dir();
    if let Err(err) = std::fs::create_dir_all(&dir) {
        logln!("island", "open data dir: cannot create {}: {err}", dir.display());
        return;
    }
    match std::process::Command::new("explorer").arg(&dir).spawn() {
        Ok(_) => logln!("island", "opened data dir {}", dir.display()),
        Err(err) => logln!("island", "open data dir failed: {err}"),
    }
}

/// Open `data/logs/` so a user can attach the file to a bug report.
#[tauri::command]
fn open_logs_dir() {
    let path = logging::log_path();
    let Some(dir) = path.parent() else { return };
    if let Err(err) = std::fs::create_dir_all(dir) {
        logln!("island", "cannot create {}: {err}", dir.display());
        return;
    }
    match std::process::Command::new("explorer").arg(dir).spawn() {
        Ok(_) => logln!("island", "opened logs dir {}", dir.display()),
        Err(err) => logln!("island", "open logs dir failed: {err}"),
    }
}

/// Frontend errors (a widget that failed to mount, a rejected command) end up
/// in the same file as the native ones, otherwise «белое окно» is undebuggable.
#[tauri::command]
fn log_event(scope: String, message: String) {
    let scope = scope.chars().take(24).collect::<String>();
    logln!("ui", "[{scope}] {message}");
}

#[tauri::command]
fn show_island_cmd(app: AppHandle) {
    show_island(&app);
}

#[tauri::command]
fn hide_island_cmd(app: AppHandle) {
    hide_island_manual(&app);
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Process name (lower-case, no `.exe`) and title of the foreground window.
#[derive(Clone, Serialize)]
struct ForegroundAppInfo {
    process: String,
    title: String,
}

#[tauri::command]
fn foreground_app() -> Option<ForegroundAppInfo> {
    winapi_ext::foreground_app().map(|(process, title)| ForegroundAppInfo { process, title })
}

/// `obs64.exe` and `OBS64` both match the process stem `obs64`.
fn process_matches(entry: &str, process: &str) -> bool {
    let normalized = entry.trim().to_lowercase();
    let normalized = normalized.strip_suffix(".exe").unwrap_or(&normalized);
    !normalized.is_empty() && normalized == process
}

/// Fingerprint of the monitor the island lives on. Undocking, waking from sleep
/// or changing the Windows scaling all change it, and all of them invalidate
/// the saved pixel position and the rounded window region.
fn display_signature(window: &WebviewWindow, s: &Settings) -> String {
    let Some(monitor) = target_monitor(window, s) else {
        return String::new();
    };
    let pos = monitor.position();
    let area = monitor.work_area();
    format!(
        "{}x{}|{}x{}+{}+{}|{}",
        pos.x,
        pos.y,
        area.size.width,
        area.size.height,
        area.position.x,
        area.position.y,
        monitor.scale_factor()
    )
}

// ---------------------------------------------------------------------------
// Background watcher: fullscreen / maximized auto-hide
// ---------------------------------------------------------------------------

fn spawn_foreground_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_monitor: Option<winapi_ext::Rect> = None;
        let mut last_display = String::new();
        loop {
            std::thread::sleep(Duration::from_millis(700));
            let Some(state) = app.try_state::<IslandState>() else {
                continue;
            };

            let s = lock(&state.settings).clone();
            let Some(win) = main_window(&app) else { continue };

            // Monitor unplugged, display scaling changed or the machine woke
            // up: put the island back on a real screen and let the webview
            // recompute its region.
            let signature = display_signature(&win, &s);
            if signature != last_display {
                if !last_display.is_empty() {
                    let (w, h) = *lock(&state.size);
                    apply_island_bounds(&win, &s, w, h);
                    let _ = app.emit("island://display-changed", signature.clone());
                    logln!("display", "layout changed -> {signature}");
                }
                last_display = signature;
            }

            // Follow the active window across monitors when configured.
            if s.monitor_follow && s.monitor_mode == "active" {
                let monitor = winapi_ext::foreground_monitor_rect();
                if monitor != last_monitor {
                    last_monitor = monitor;
                    let (w, h) = *lock(&state.size);
                    apply_island_bounds(&win, &s, w, h);
                }
            }

            if state.manual_hidden.load(Ordering::SeqCst) {
                continue;
            }

            let fg = winapi_ext::foreground_state();
            // Apps on the exception list keep the island visible even when they
            // cover the whole screen (games, OBS, video players).
            let excepted = !s.auto_hide_exceptions.is_empty()
                && winapi_ext::foreground_app()
                    .map(|(process, _)| {
                        s.auto_hide_exceptions
                            .iter()
                            .any(|entry| process_matches(entry, &process))
                    })
                    .unwrap_or(false);
            let should_hide = !excepted
                && ((s.hide_in_fullscreen && fg == ForegroundState::Fullscreen)
                    || (s.hide_on_maximized && fg == ForegroundState::Maximized));

            let currently_auto = state.auto_hidden.load(Ordering::SeqCst);
            if should_hide && !currently_auto {
                state.auto_hidden.store(true, Ordering::SeqCst);
                set_visible_raw(&win, false);
            } else if !should_hide && currently_auto {
                state.auto_hidden.store(false, Ordering::SeqCst);
                set_visible_raw(&win, true);
            }
        }
    });
}

// ---------------------------------------------------------------------------
// App bootstrap
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let settings = Settings::load();

    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    logln!("hotkeys", "event {shortcut} {:?}", event.state());
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let Some(hk) = app
                        .try_state::<HotkeyRegistry>()
                        .and_then(|registry| registry.snapshot())
                    else {
                        return;
                    };
                    if shortcut == &hk.toggle {
                        toggle_island(app);
                    } else if shortcut == &hk.hide {
                        hide_island_manual(app);
                    } else if shortcut == &hk.settings {
                        let _ = open_settings(app);
                    }
                })
                .build(),
        )
        .manage(IslandState {
            settings: Mutex::new(settings.clone()),
            manual_hidden: AtomicBool::new(false),
            auto_hidden: AtomicBool::new(false),
            size: Mutex::new({
                let (w, h) = collapsed_logical_size(&settings);
                // Same formula as the web view: the layout box never shrinks
                // below 100 % because the UI scale is a CSS transform.
                (w * settings.scale.max(1.0) + 48.0, h * settings.scale + 20.0)
            }),
            cpu: Mutex::new(CpuSampler::new()),
        })
        .manage(HotkeyRegistry::default())
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            set_island_bounds,
            set_hit_rect,
            set_island_expanded,
            start_file_drag,
            drift_island,
            hotkey_status,
            get_system_stats,
            get_disk_stats,
            beep,
            read_store,
            write_store,
            list_monitors,
            open_data_dir,
            open_logs_dir,
            log_event,
            show_island_cmd,
            hide_island_cmd,
            open_settings_window,
            media_state,
            media_art,
            media_control,
            media_control_source,
            media_select,
            media_volume,
            media_set_volume,
            media_set_mute,
            copy_files,
            clipboard_files,
            copy_text,
            open_path,
            reveal_path,
            describe_paths,
            foreground_app,
            quit_app
        ])
        .setup(move |app| {
            let handle = app.handle().clone();

            logln!(
                "app",
                "start v{} theme={} mode={} scale={} monitor={}:{}",
                env!("CARGO_PKG_VERSION"),
                settings.theme,
                settings.collapsed_mode,
                settings.scale,
                settings.monitor_mode,
                settings.monitor_index
            );
            logln!("app", "data dir {}", data_dir().display());

            // Start position: collapsed island (line or pill) on the target monitor.
            if let Some(win) = main_window(&handle) {
                let (w, h) = collapsed_logical_size(&settings);
                apply_island_bounds(
                    &win,
                    &settings,
                    w * settings.scale + 48.0,
                    h * settings.scale + 20.0,
                );
                // A tool window is invisible to Alt+Tab, taskbar previews and
                // the shell's window cards: the only thing Windows may ever
                // draw for the island is the island itself.
                if let Ok(hwnd) = win.hwnd() {
                    winapi_ext::mark_tool_window(hwnd.0 as isize);
                }
                // No title anywhere: nothing to show in a preview or tooltip.
                let _ = win.set_title("");
            }

            // Shortcuts
            install_hotkeys(app.handle(), &settings);

            // Tray
            let toggle_item =
                MenuItem::with_id(app, "toggle", "Показать / скрыть", true, None::<&str>)?;
            let settings_item = MenuItem::with_id(app, "settings", "Настройки", true, None::<&str>)?;
            let data_item = MenuItem::with_id(app, "data", "Папка данных", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[&toggle_item, &settings_item, &data_item, &quit_item],
            )?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Win Island")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "toggle" => toggle_island(app),
                    "settings" => {
                        let _ = open_settings(app);
                    }
                    "data" => open_data_dir(),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_island(tray.app_handle());
                    }
                })
                .build(app)?;

            spawn_foreground_watcher(handle);

            // Dev helper: `WIN_ISLAND_OPEN_SETTINGS=1` opens the standalone
            // settings window on startup, so it can be checked without the
            // (configurable, sometimes occupied) global shortcut.
            #[cfg(debug_assertions)]
            if std::env::var_os("WIN_ISLAND_OPEN_SETTINGS").is_some() {
                let app_handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    let _ = open_settings(&app_handle);
                    std::thread::sleep(std::time::Duration::from_millis(700));
                    if let Some(w) = app_handle.get_webview_window("settings") {
                        // Dev: park the window on the secondary monitor so the
                        // user's primary screen stays usable during checks.
                        let _ = w.set_size(tauri::LogicalSize::new(400.0, 440.0));
                        let _ = w.set_position(tauri::PhysicalPosition::new(-1500, 30));
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Both windows only ever hide. Closing the settings window used
                // to destroy its webview while leaving the window registered,
                // so the next "open settings" showed a blank frame.
                api.prevent_close();
                let _ = window.hide();
                if window.label() == "main" {
                    if let Some(state) = window.app_handle().try_state::<IslandState>() {
                        state.manual_hidden.store(true, Ordering::SeqCst);
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Win Island");
}
