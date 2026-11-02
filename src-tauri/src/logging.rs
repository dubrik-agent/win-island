//! Tiny file logger. `eprintln!` is invisible in release builds (no console),
//! which makes "the window is white" or "the hotkey does nothing" impossible to
//! diagnose on the user's machine.
//!
//! Everything goes to `data/logs/win-island.log`, capped at ~256 KB.

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

const MAX_BYTES: u64 = 256 * 1024;

static LOG_LOCK: Mutex<()> = Mutex::new(());

pub fn log_path() -> PathBuf {
    crate::settings::data_dir().join("logs").join("win-island.log")
}

pub fn write(scope: &str, message: impl AsRef<str>) {
    let _guard = LOG_LOCK.lock();
    let path = log_path();
    if let Some(dir) = path.parent() {
        if fs::create_dir_all(dir).is_err() {
            return;
        }
    }
    if fs::metadata(&path).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        // Keep the tail: rotate to `.1` so the newest lines always survive.
        let _ = fs::rename(&path, path.with_extension("log.1"));
    }
    let stamp = timestamp();
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{stamp} [{scope}] {message}", message = message.as_ref());
    }
}

#[macro_export]
macro_rules! logln {
    ($scope:expr, $($arg:tt)*) => {
        $crate::logging::write($scope, format!($($arg)*))
    };
}

/// `YYYY-MM-DD HH:MM:SS` in **local** time — support logs are read by a person
/// comparing them to their own clock, so UTC would only confuse.
fn timestamp() -> String {
    #[repr(C)]
    struct SystemTime {
        year: u16,
        month: u16,
        day_of_week: u16,
        day: u16,
        hour: u16,
        minute: u16,
        second: u16,
        milliseconds: u16,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetLocalTime(time: *mut SystemTime);
    }
    let mut now = SystemTime {
        year: 0,
        month: 0,
        day_of_week: 0,
        day: 0,
        hour: 0,
        minute: 0,
        second: 0,
        milliseconds: 0,
    };
    // SAFETY: `GetLocalTime` only writes into the struct we own.
    unsafe { GetLocalTime(&mut now) };
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        now.year, now.month, now.day, now.hour, now.minute, now.second
    )
}
