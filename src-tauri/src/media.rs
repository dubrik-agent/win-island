//! Now playing bridge over Windows SMTC (System Media Transport Controls).
//!
//! Windows exposes whatever a player publishes through
//! `GlobalSystemMediaTransportControlsSessionManager`: title, artist, album,
//! artwork, position and transport controls. No extra runtime, no helpers —
//! the same source the shell's own media flyout uses.

use std::cell::Cell;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use windows::core::Interface;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as Manager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
};
use windows::Storage::Streams::{DataReader, IInputStream};
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

thread_local! {
    static COM_READY: Cell<bool> = const { Cell::new(false) };
}

/// Tauri invokes commands off the UI thread, so make sure that thread has
/// joined the multithreaded apartment before touching WinRT. The UI thread
/// itself stays STA for WebView2.
fn ensure_apartment() {
    COM_READY.with(|ready| {
        if ready.get() {
            return;
        }
        // RPC_E_CHANGED_MODE (already STA) is harmless: WinRT still works for
        // the cheap, agile calls we make here.
        unsafe {
            let _ = RoInitialize(RO_INIT_MULTITHREADED);
        }
        ready.set(true);
    });
}

static MANAGER: OnceLock<Mutex<Option<Manager>>> = OnceLock::new();
static PREFERRED: Mutex<Option<String>> = Mutex::new(None);
static ART_CACHE: Mutex<Option<(String, Option<String>)>> = Mutex::new(None);

fn manager() -> Result<Manager, String> {
    let cell = MANAGER.get_or_init(|| Mutex::new(None));
    let mut guard = cell.lock().map_err(|_| "media lock poisoned")?;
    if let Some(manager) = guard.as_ref() {
        return Ok(manager.clone());
    }
    let manager = Manager::RequestAsync()
        .map_err(|e| e.to_string())?
        .join()
        .map_err(|e| e.to_string())?;
    *guard = Some(manager.clone());
    Ok(manager)
}

fn all_sessions(manager: &Manager) -> Vec<Session> {
    let Ok(list) = manager.GetSessions() else {
        return Vec::new();
    };
    let Ok(size) = list.Size() else {
        return Vec::new();
    };
    (0..size).filter_map(|i| list.GetAt(i).ok()).collect()
}

fn status_of(session: &Session) -> Status {
    session
        .GetPlaybackInfo()
        .and_then(|info| info.PlaybackStatus())
        .unwrap_or(Status::Closed)
}

fn app_id_of(session: &Session) -> String {
    session
        .SourceAppUserModelId()
        .map(|id| id.to_string())
        .unwrap_or_default()
}

fn pick_session(manager: &Manager) -> Option<Session> {
    let preferred = PREFERRED.lock().ok().and_then(|guard| guard.clone());
    let sessions = all_sessions(manager);
    if let Some(id) = preferred.filter(|id| !id.is_empty()) {
        if let Some(found) = sessions.iter().find(|s| app_id_of(s) == id) {
            return Some(found.clone());
        }
    }
    if let Ok(current) = manager.GetCurrentSession() {
        if current.GetPlaybackInfo().is_ok() {
            return Some(current);
        }
    }
    sessions
        .iter()
        .find(|s| status_of(s) == Status::Playing)
        .or_else(|| sessions.first())
        .cloned()
}

fn text(value: windows::core::Result<windows::core::HSTRING>) -> String {
    value.map(|s| s.to_string()).unwrap_or_default()
}

fn ten_ms_to_ms(value: i64) -> u64 {
    (value.max(0) / 10_000) as u64
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    pub app: String,
    pub title: String,
    pub playing: bool,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub active: bool,
    pub app: String,
    pub app_id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub playing: bool,
    pub can_next: bool,
    pub can_prev: bool,
    pub can_seek: bool,
    pub position_ms: u64,
    pub duration_ms: u64,
    pub art_key: String,
    pub sources: Vec<Source>,
}

pub fn snapshot() -> Snapshot {
    ensure_apartment();
    let Ok(manager) = manager() else {
        return Snapshot::default();
    };
    let sources = all_sessions(&manager)
        .iter()
        .map(|s| {
            let props = s.TryGetMediaPropertiesAsync().ok().and_then(|op| op.join().ok());
            Source {
                id: app_id_of(s),
                app: pretty_app(&app_id_of(s)),
                title: props.map(|p| text(p.Title())).unwrap_or_default(),
                playing: status_of(s) == Status::Playing,
            }
        })
        .collect::<Vec<_>>();

    let Some(session) = pick_session(&manager) else {
        return Snapshot {
            sources,
            ..Snapshot::default()
        };
    };

    let app_id = app_id_of(&session);
    let info = session.GetPlaybackInfo().ok();
    let status = info
        .as_ref()
        .and_then(|i| i.PlaybackStatus().ok())
        .unwrap_or(Status::Closed);
    let controls = info.as_ref().and_then(|i| i.Controls().ok());
    let props = session
        .TryGetMediaPropertiesAsync()
        .ok()
        .and_then(|op| op.join().ok());

    let (title, artist, album) = match props {
        Some(p) => (text(p.Title()), text(p.Artist()), text(p.AlbumTitle())),
        None => (String::new(), String::new(), String::new()),
    };

    let (position_ms, duration_ms) = match session.GetTimelineProperties() {
        Ok(timeline) => {
            let start = timeline.StartTime().map(|t| t.Duration).unwrap_or(0);
            let end = timeline.EndTime().map(|t| t.Duration).unwrap_or(0);
            let position = timeline.Position().map(|t| t.Duration).unwrap_or(0);
            (
                ten_ms_to_ms(position - start),
                ten_ms_to_ms(end - start),
            )
        }
        Err(_) => (0, 0),
    };

    Snapshot {
        active: !title.is_empty() || !artist.is_empty(),
        app: pretty_app(&app_id),
        art_key: format!("{app_id}\u{1}{title}\u{1}{artist}\u{1}{album}"),
        app_id,
        title,
        artist,
        album,
        playing: status == Status::Playing,
        can_next: controls
            .as_ref()
            .and_then(|c| c.IsNextEnabled().ok())
            .unwrap_or(false),
        can_prev: controls
            .as_ref()
            .and_then(|c| c.IsPreviousEnabled().ok())
            .unwrap_or(false),
        can_seek: controls
            .as_ref()
            .and_then(|c| c.IsPlaybackPositionEnabled().ok())
            .unwrap_or(false),
        position_ms,
        duration_ms,
        sources,
    }
}

pub fn artwork() -> Option<String> {
    ensure_apartment();
    let manager = manager().ok()?;
    let session = pick_session(&manager)?;
    let key = session
        .TryGetMediaPropertiesAsync()
        .ok()
        .and_then(|op| op.join().ok())
        .map(|p| {
            format!(
                "{}\u{1}{}\u{1}{}\u{1}{}",
                app_id_of(&session),
                text(p.Title()),
                text(p.Artist()),
                text(p.AlbumTitle())
            )
        })?;

    if let Ok(cache) = ART_CACHE.lock() {
        if let Some((cached_key, value)) = cache.as_ref() {
            if *cached_key == key {
                return value.clone();
            }
        }
    }

    let value = read_artwork(&session);
    if let Ok(mut cache) = ART_CACHE.lock() {
        *cache = Some((key, value.clone()));
    }
    value
}

fn read_artwork(session: &Session) -> Option<String> {
    let props = session
        .TryGetMediaPropertiesAsync()
        .ok()?
        .join()
        .ok()?;
    let thumb = props.Thumbnail().ok()?;
    let stream = thumb.OpenReadAsync().ok()?.join().ok()?;
    let size = stream.Size().ok()?;
    if size == 0 || size > 8 * 1024 * 1024 {
        return None;
    }
    let input: IInputStream = stream.cast().ok()?;
    let reader = DataReader::CreateDataReader(&input).ok()?;
    reader.LoadAsync(size as u32).ok()?.join().ok()?;
    let mut bytes = vec![0u8; size as usize];
    reader.ReadBytes(&mut bytes).ok()?;
    let mime = sniff_mime(&bytes);
    Some(format!("data:{mime};base64,{}", base64(&bytes)))
}

fn sniff_mime(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png"
    } else if bytes.starts_with(&[0xFF, 0xD8]) {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF8") {
        "image/gif"
    } else if bytes.starts_with(b"RIFF") && bytes.len() > 11 && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else {
        "image/jpeg"
    }
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

pub fn control(action: &str, position_ms: Option<u64>) -> Result<(), String> {
    ensure_apartment();
    let manager = manager()?;
    let session = pick_session(&manager).ok_or_else(|| "no media session".to_string())?;
    let op = match action {
        "toggle" => session.TryTogglePlayPauseAsync(),
        "next" => session.TrySkipNextAsync(),
        "prev" => session.TrySkipPreviousAsync(),
        "seek" => {
            let target = position_ms.unwrap_or(0).min(i64::MAX as u64 / 10_000) as i64;
            session.TryChangePlaybackPositionAsync(target * 10_000)
        }
        _ => return Err(format!("unknown media action: {action}")),
    }
    .map_err(|e| e.to_string())?;
    op.join().map_err(|e| e.to_string())?;
    Ok(())
}

/// Transport action on one specific session (the source row's play button),
/// without changing which source the main controls point at.
pub fn control_source(app_id: &str, action: &str) -> Result<(), String> {
    ensure_apartment();
    let manager = manager()?;
    let session = all_sessions(&manager)
        .into_iter()
        .find(|s| app_id_of(s) == app_id)
        .ok_or_else(|| "no such media session".to_string())?;
    let op = match action {
        "toggle" => session.TryTogglePlayPauseAsync(),
        "next" => session.TrySkipNextAsync(),
        "prev" => session.TrySkipPreviousAsync(),
        _ => return Err(format!("unknown media action: {action}")),
    }
    .map_err(|e| e.to_string())?;
    op.join().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn select(app_id: &str) {
    if let Ok(mut preferred) = PREFERRED.lock() {
        *preferred = if app_id.is_empty() {
            None
        } else {
            Some(app_id.to_string())
        };
    }
}

/// AUMIDs are not meant for humans: `Spotify.exe`, `Chrome.exe`,
/// `Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic`…
fn pretty_app(id: &str) -> String {
    if id.is_empty() {
        return "Медиа".to_string();
    }
    let base = id.rsplit('!').next().unwrap_or(id);
    let base = base.split('_').next().unwrap_or(base);
    let base = base.trim_end_matches(".exe");
    let lower = base.to_lowercase();
    // Chromium-based players publish an auto-generated AUMID instead of a
    // readable one; showing a GUID in the UI helps nobody.
    if lower.starts_with("microsoft.autogenerated") || base.contains('{') {
        return "Браузер".to_string();
    }
    match lower.as_str() {
        "spotify" => "Spotify".to_string(),
        "chrome" => "Chrome".to_string(),
        "msedge" => "Edge".to_string(),
        "firefox" => "Firefox".to_string(),
        "opera" | "opera_gx" => "Opera".to_string(),
        "brave" => "Brave".to_string(),
        "vlc" => "VLC".to_string(),
        "aimp" => "AIMP".to_string(),
        "foobar2000" => "foobar2000".to_string(),
        "microsoft.zunemusic" => "Media Player".to_string(),
        "telegram" => "Telegram".to_string(),
        "yandexmusic" | "yandex.music" => "Яндекс Музыка".to_string(),
        "musicbee" => "MusicBee".to_string(),
        _ => base.to_string(),
    }
}
