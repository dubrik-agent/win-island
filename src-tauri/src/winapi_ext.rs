//! Minimal, dependency-free Win32 bindings used by the island.
//! Kept hand-written on purpose: no extra crates, no version drift, tiny binary.

#![allow(non_snake_case)]

use std::mem::size_of;

pub type Hwnd = isize;

#[repr(C)]
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    pub fn height(&self) -> i32 {
        self.bottom - self.top
    }
}

#[repr(C)]
struct MonitorInfo {
    cb_size: u32,
    rc_monitor: Rect,
    rc_work: Rect,
    dw_flags: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct FileTime {
    low: u32,
    high: u32,
}

impl FileTime {
    fn value(&self) -> u64 {
        ((self.high as u64) << 32) | self.low as u64
    }
}

#[repr(C)]
#[derive(Default)]
struct MemoryStatusEx {
    length: u32,
    memory_load: u32,
    total_phys: u64,
    avail_phys: u64,
    total_page_file: u64,
    avail_page_file: u64,
    total_virtual: u64,
    avail_virtual: u64,
    avail_extended_virtual: u64,
}

#[link(name = "user32")]
unsafe extern "system" {
    fn OpenClipboard(hwnd: Hwnd) -> i32;
    fn CloseClipboard() -> i32;
    fn EmptyClipboard() -> i32;
    fn SetClipboardData(format: u32, mem: isize) -> isize;
    fn GetClipboardData(format: u32) -> isize;
    fn GetForegroundWindow() -> Hwnd;
    fn GetWindowRect(hwnd: Hwnd, rect: *mut Rect) -> i32;
    fn GetClassNameW(hwnd: Hwnd, buf: *mut u16, max: i32) -> i32;
    fn GetWindowTextW(hwnd: Hwnd, buf: *mut u16, max: i32) -> i32;
    fn GetWindowThreadProcessId(hwnd: Hwnd, pid: *mut u32) -> u32;
    fn MonitorFromWindow(hwnd: Hwnd, flags: u32) -> isize;
    fn GetMonitorInfoW(monitor: isize, info: *mut MonitorInfo) -> i32;
    fn MessageBeep(kind: u32) -> i32;
    fn SetWindowRgn(hwnd: Hwnd, region: isize, redraw: i32) -> i32;
    fn ShowWindow(hwnd: Hwnd, cmd: i32) -> i32;
    fn GetWindowLongPtrW(hwnd: Hwnd, index: i32) -> isize;
    fn SetWindowLongPtrW(hwnd: Hwnd, index: i32, value: isize) -> isize;
}

#[link(name = "gdi32")]
unsafe extern "system" {
    fn CreateRoundRectRgn(
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
        width_ellipse: i32,
        height_ellipse: i32,
    ) -> isize;
    fn DeleteObject(object: isize) -> i32;
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GlobalMemoryStatusEx(out: *mut MemoryStatusEx) -> i32;
    fn GetSystemTimes(idle: *mut FileTime, kernel: *mut FileTime, user: *mut FileTime) -> i32;
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
    fn CloseHandle(handle: isize) -> i32;
    fn QueryFullProcessImageNameW(process: isize, flags: u32, buf: *mut u16, size: *mut u32) -> i32;
    fn GetLogicalDrives() -> u32;
    fn GetDriveTypeW(root: *const u16) -> u32;
    fn GetDiskFreeSpaceExW(
        dir: *const u16,
        free_to_caller: *mut u64,
        total: *mut u64,
        free_total: *mut u64,
    ) -> i32;
    fn GetTickCount64() -> u64;
}

#[link(name = "shell32")]
unsafe extern "system" {
    fn SHParseDisplayName(
        name: *const u16,
        bind_ctx: *mut std::ffi::c_void,
        pidl: *mut *mut std::ffi::c_void,
        attrs_in: u32,
        attrs_out: *mut u32,
    ) -> i32;
    fn ILFindLastID(pidl: *const std::ffi::c_void) -> *const std::ffi::c_void;
    fn ILRemoveLastID(pidl: *mut std::ffi::c_void) -> i32;
    fn SHOpenFolderAndSelectItems(
        folder: *const std::ffi::c_void,
        count: u32,
        items: *const *const std::ffi::c_void,
        flags: u32,
    ) -> i32;
}

#[link(name = "ole32")]
unsafe extern "system" {
    fn CoInitializeEx(reserved: *mut std::ffi::c_void, co_init: u32) -> i32;
    fn CoUninitialize();
    fn CoTaskMemFree(mem: *mut std::ffi::c_void);
}

const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;

const MONITOR_DEFAULTTONEAREST: u32 = 2;

#[derive(PartialEq, Eq, Clone, Copy, Debug)]
pub enum ForegroundState {
    Normal,
    Maximized,
    Fullscreen,
}

fn class_name(hwnd: Hwnd) -> String {
    let mut buf = [0u16; 128];
    let len = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
    if len <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buf[..len as usize])
}

/// Rect of the monitor that currently contains the foreground window (physical px).
pub fn foreground_monitor_rect() -> Option<Rect> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd == 0 {
            return None;
        }
        let mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        if mon == 0 {
            return None;
        }
        let mut info: MonitorInfo = std::mem::zeroed();
        info.cb_size = size_of::<MonitorInfo>() as u32;
        if GetMonitorInfoW(mon, &mut info) == 0 {
            return None;
        }
        Some(info.rc_monitor)
    }
}

/// Shows a window without activating it, so a global hotkey never steals focus
/// from whatever the user is typing in.
pub fn show_no_activate(hwnd: Hwnd) {
    unsafe {
        ShowWindow(hwnd, 4); // SW_SHOWNOACTIVATE
    }
}

/// Hides a window directly.
///
/// Must be paired with [`show_no_activate`]: `WebviewWindow::hide()` keeps its
/// own visibility cache, which raw `ShowWindow` calls never update. Mixing the
/// two makes the *second* `hide()` a no-op (tao thinks the window is already
/// hidden) and the island can no longer be hidden from the UI.
pub fn hide_window(hwnd: Hwnd) {
    unsafe {
        ShowWindow(hwnd, 0); // SW_HIDE
    }
}

/// Detects if the current foreground window is fullscreen or maximized.
pub fn foreground_state() -> ForegroundState {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd == 0 {
            return ForegroundState::Normal;
        }
        let class = class_name(hwnd);
        if class == "Progman" || class == "WorkerW" || class == "Shell_TrayWnd" {
            return ForegroundState::Normal;
        }
        let mut wr = Rect::default();
        if GetWindowRect(hwnd, &mut wr) == 0 {
            return ForegroundState::Normal;
        }
        let mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        if mon == 0 {
            return ForegroundState::Normal;
        }
        let mut info: MonitorInfo = std::mem::zeroed();
        info.cb_size = size_of::<MonitorInfo>() as u32;
        if GetMonitorInfoW(mon, &mut info) == 0 {
            return ForegroundState::Normal;
        }
        let m = info.rc_monitor;
        if wr.left <= m.left && wr.top <= m.top && wr.right >= m.right && wr.bottom >= m.bottom {
            return ForegroundState::Fullscreen;
        }
        let w = info.rc_work;
        let close = |a: i32, b: i32| (a - b).abs() <= 2;
        if close(wr.left, w.left)
            && close(wr.top, w.top)
            && close(wr.right, w.right)
            && close(wr.bottom, w.bottom)
            && w.height() > 0
        {
            return ForegroundState::Maximized;
        }
        ForegroundState::Normal
    }
}

/// Lower-case executable stem of the given process (`obs64.exe` → `obs64`).
pub fn process_name(pid: u32) -> Option<String> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle == 0 {
            return None;
        }
        let mut buf = [0u16; 1024];
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut size);
        CloseHandle(handle);
        if ok == 0 || size == 0 {
            return None;
        }
        let path = String::from_utf16_lossy(&buf[..size as usize]);
        let file = path.rsplit(['\\', '/']).next()?.to_lowercase();
        let stem = file.strip_suffix(".exe").unwrap_or(&file).to_string();
        if stem.is_empty() {
            None
        } else {
            Some(stem)
        }
    }
}

/// Process name and window title of the foreground window.
pub fn foreground_app() -> Option<(String, String)> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd == 0 {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == 0 {
            return None;
        }
        let process = process_name(pid)?;
        let mut buf = [0u16; 512];
        let len = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        let title = if len > 0 {
            String::from_utf16_lossy(&buf[..len as usize])
        } else {
            String::new()
        };
        Some((process, title))
    }
}

/// Incremental CPU usage sampler (delta between two reads of GetSystemTimes).
pub struct CpuSampler {
    last_idle: u64,
    last_total: u64,
}

impl CpuSampler {
    pub fn new() -> Self {
        let (idle, total) = read_times();
        Self {
            last_idle: idle,
            last_total: total,
        }
    }

    /// Returns CPU usage percentage (0..100) since the previous call.
    pub fn usage(&mut self) -> f32 {
        let (idle, total) = read_times();
        let idle_delta = idle.saturating_sub(self.last_idle);
        let total_delta = total.saturating_sub(self.last_total);
        self.last_idle = idle;
        self.last_total = total;
        if total_delta == 0 {
            return 0.0;
        }
        let busy = total_delta.saturating_sub(idle_delta);
        (busy as f64 * 100.0 / total_delta as f64) as f32
    }
}

fn read_times() -> (u64, u64) {
    let mut idle = FileTime::default();
    let mut kernel = FileTime::default();
    let mut user = FileTime::default();
    unsafe {
        if GetSystemTimes(&mut idle, &mut kernel, &mut user) == 0 {
            return (0, 0);
        }
    }
    // kernel time includes idle time
    (
        idle.value(),
        kernel.value().saturating_add(user.value()),
    )
}

/// Returns (used_bytes, total_bytes) of physical memory.
pub fn memory_usage() -> (u64, u64) {
    let mut status = MemoryStatusEx::default();
    status.length = size_of::<MemoryStatusEx>() as u32;
    unsafe {
        if GlobalMemoryStatusEx(&mut status) == 0 {
            return (0, 0);
        }
    }
    (
        status.total_phys.saturating_sub(status.avail_phys),
        status.total_phys,
    )
}

pub fn beep(kind: u32) {
    unsafe {
        MessageBeep(kind);
    }
}

// ---------------------------------------------------------------------------
// Window region: the native window is larger than the island (room for the
// drop shadow), so the area outside the island is clipped away at the window
// level. `HTTRANSPARENT` only forwards inside one thread and `WS_EX_TRANSPARENT`
// is ignored by the cross-process WebView2 children; a window region covers the
// whole tree, so clicks next to the island reach the app underneath.
// ---------------------------------------------------------------------------

/// Optional trace of the region logic: set `WIN_ISLAND_HIT_LOG` to a file path
/// to see which region the window uses.
fn hit_log(line: &str) {
    let Some(path) = std::env::var_os("WIN_ISLAND_HIT_LOG") else {
        return;
    };
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        use std::io::Write;
        let _ = writeln!(file, "{line}");
    }
}

/// Cuts the native window down to the island itself — not a pixel more.
///
/// A window region clips hit-testing for the *whole* window tree, including the
/// cross-process `WebView2` children that ignore `WS_EX_TRANSPARENT`. That is
/// what makes clicks on browser tabs next to the island reach the browser
/// instead of being swallowed by an invisible rectangle.
///
/// There is deliberately **no padding**: any margin kept for a drop shadow is a
/// margin the user cannot click through. The shadow is drawn inside the island
/// instead (see `#island` in `styles.css`).
pub fn apply_island_region(hwnd: Hwnd, rect: Rect, radius: i32) {
    let rounded = radius.max(2);
    unsafe {
        let rgn = CreateRoundRectRgn(
            rect.left,
            rect.top,
            rect.right + 1,
            rect.bottom + 1,
            rounded * 2,
            rounded * 2,
        );
        if rgn == 0 {
            return;
        }
        // `false` keeps the window from repainting on every animation frame.
        if SetWindowRgn(hwnd, rgn, 0) == 0 {
            let _ = DeleteObject(rgn);
        }
    }
    hit_log(&format!(
        "region {}x{} at {},{} r={radius}",
        rect.right - rect.left,
        rect.bottom - rect.top,
        rect.left,
        rect.top
    ));
}

/// Marks a window as a tool window: it disappears from Alt+Tab, from taskbar
/// thumbnails and from the shell's window previews, so nothing outside the
/// island itself can ever be drawn (or clicked) for it.
pub fn mark_tool_window(hwnd: Hwnd) {
    const GWL_EXSTYLE: i32 = -20;
    const WS_EX_TOOLWINDOW: isize = 0x0000_0080;
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        if style == 0 {
            return;
        }
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style | WS_EX_TOOLWINDOW);
    }
}

// ---------------------------------------------------------------------------
// Clipboard files (CF_HDROP) and shell helpers — powers the file shelf.
// ---------------------------------------------------------------------------

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::time::Duration as StdDuration;

const CF_HDROP: u32 = 15;
const CF_UNICODETEXT: u32 = 13;
const GMEM_MOVEABLE: u32 = 0x0002;
const SW_SHOWNORMAL: i32 = 1;

#[repr(C)]
struct DropFiles {
    p_files: u32,
    pt_x: i32,
    pt_y: i32,
    f_nc: i32,
    f_wide: i32,
}

#[link(name = "shell32")]
unsafe extern "system" {
    fn DragQueryFileW(hdrop: isize, index: u32, buf: *mut u16, cch: u32) -> u32;
    fn ShellExecuteW(
        hwnd: Hwnd,
        op: *const u16,
        file: *const u16,
        params: *const u16,
        dir: *const u16,
        show: i32,
    ) -> isize;
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GlobalAlloc(flags: u32, bytes: usize) -> isize;
    fn GlobalLock(mem: isize) -> *mut u8;
    fn GlobalUnlock(mem: isize) -> i32;
    fn GlobalFree(mem: isize) -> isize;
}

fn wide(text: &str) -> Vec<u16> {
    OsStr::new(text)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// The clipboard is a single global resource: another app may hold it for a
/// few milliseconds, so retry briefly instead of failing the user's action.
fn with_clipboard<T>(body: impl FnOnce() -> T) -> Option<T> {
    for _ in 0..6 {
        unsafe {
            if OpenClipboard(0) != 0 {
                let value = body();
                CloseClipboard();
                return Some(value);
            }
        }
        std::thread::sleep(StdDuration::from_millis(15));
    }
    None
}

fn alloc_global(bytes: &[u8]) -> isize {
    unsafe {
        let mem = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1));
        if mem == 0 {
            return 0;
        }
        let ptr = GlobalLock(mem);
        if ptr.is_null() {
            GlobalFree(mem);
            return 0;
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len());
        GlobalUnlock(mem);
        mem
    }
}

/// Puts real files on the clipboard: paste works in Explorer, Telegram, mail
/// clients and anything else that accepts CF_HDROP.
pub fn copy_paths_to_clipboard(paths: &[String]) -> Result<(), String> {
    let files: Vec<&str> = paths
        .iter()
        .map(String::as_str)
        .filter(|path| !path.is_empty())
        .collect();
    if files.is_empty() {
        return Err("нет файлов для копирования".to_string());
    }

    let mut list: Vec<u16> = Vec::new();
    for path in &files {
        list.extend(OsStr::new(path).encode_wide());
        list.push(0);
    }
    list.push(0);

    let header = size_of::<DropFiles>();
    let mut raw = vec![0u8; header + list.len() * 2];
    let drop = raw.as_mut_ptr() as *mut DropFiles;
    unsafe {
        (*drop).p_files = header as u32;
        (*drop).pt_x = 0;
        (*drop).pt_y = 0;
        (*drop).f_nc = 0;
        (*drop).f_wide = 1;
        std::ptr::copy_nonoverlapping(
            list.as_ptr() as *const u8,
            raw.as_mut_ptr().add(header),
            list.len() * 2,
        );
    }

    let text = files.join("\r\n");
    let text_wide: Vec<u8> = text
        .encode_utf16()
        .chain(std::iter::once(0))
        .flat_map(u16::to_le_bytes)
        .collect();

    let result = with_clipboard(|| unsafe {
        EmptyClipboard();

        let mem = alloc_global(&raw);
        if mem == 0 {
            return Err("не удалось выделить память".to_string());
        }
        if SetClipboardData(CF_HDROP, mem) == 0 {
            GlobalFree(mem);
            return Err("буфер обмена отклонил файлы".to_string());
        }

        // Plain text is a convenience for apps that do not read file lists.
        let text_mem = alloc_global(&text_wide);
        if text_mem != 0 && SetClipboardData(CF_UNICODETEXT, text_mem) == 0 {
            GlobalFree(text_mem);
        }
        Ok(())
    });

    result.unwrap_or_else(|| Err("буфер обмена занят другим приложением".to_string()))
}

/// Plain text on the clipboard. The native route works even when the island
/// window is not focused, where the web clipboard API is blocked.
pub fn copy_text_to_clipboard(text: &str) -> Result<(), String> {
    if text.is_empty() {
        return Err("нечего копировать".to_string());
    }
    let bytes: Vec<u8> = OsStr::new(text)
        .encode_wide()
        .chain(std::iter::once(0))
        .flat_map(u16::to_le_bytes)
        .collect();

    let result = with_clipboard(|| unsafe {
        EmptyClipboard();
        let mem = alloc_global(&bytes);
        if mem == 0 {
            return Err("не удалось выделить память".to_string());
        }
        if SetClipboardData(CF_UNICODETEXT, mem) == 0 {
            GlobalFree(mem);
            return Err("буфер обмена отклонил текст".to_string());
        }
        Ok(())
    });

    result.unwrap_or_else(|| Err("буфер обмена занят другим приложением".to_string()))
}

/// Files currently in the clipboard, if they were copied from Explorer.
pub fn clipboard_files() -> Vec<String> {    with_clipboard(|| unsafe {
        let handle = GetClipboardData(CF_HDROP);
        if handle == 0 {
            return Vec::new();
        }
        let count = DragQueryFileW(handle, u32::MAX, std::ptr::null_mut(), 0);
        let mut out = Vec::with_capacity(count as usize);
        for index in 0..count {
            let len = DragQueryFileW(handle, index, std::ptr::null_mut(), 0);
            if len == 0 {
                continue;
            }
            let mut buf = vec![0u16; len as usize + 1];
            let written = DragQueryFileW(handle, index, buf.as_mut_ptr(), buf.len() as u32);
            if written > 0 {
                out.push(String::from_utf16_lossy(&buf[..written as usize]));
            }
        }
        out
    })
    .unwrap_or_default()
}

/// Opens a file or folder with its default handler.
pub fn open_path(path: &str) -> bool {
    let op = wide("open");
    let file = wide(path);
    unsafe {
        ShellExecuteW(
            0,
            op.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        ) as usize
            > 32
    }
}

/// Opens Explorer on the folder that really contains `path` and selects the
/// file there.
///
/// `explorer /select,<path>` breaks on spaces and commas and silently opens
/// Documents instead, which is exactly the bug users hit. The shell API works
/// with a PIDL of the *full* path, so two files with the same name in different
/// folders can never be confused.
pub fn reveal_in_folder(path: &str) -> Result<(), String> {
    if !std::path::Path::new(path).exists() {
        return Err("файл больше не существует".to_string());
    }
    let name = wide(path);
    unsafe {
        // Shell interfaces need an initialized apartment; the caller runs on a
        // worker thread, so COM is not initialized there yet.
        let hr = CoInitializeEx(std::ptr::null_mut(), 0x2); // STA
        if hr < 0 && hr != 0x8001_0106u32 as i32 {
            return Err(format!("COM init failed: 0x{:08x}", hr as u32));
        }
        let mut pidl: *mut std::ffi::c_void = std::ptr::null_mut();
        let parsed = SHParseDisplayName(name.as_ptr(), std::ptr::null_mut(), &mut pidl, 0, std::ptr::null_mut());
        if parsed < 0 || pidl.is_null() {
            CoUninitialize();
            return Err(format!("shell parse failed: 0x{:08x}", parsed as u32));
        }
        let child = ILFindLastID(pidl);
        // `SHOpenFolderAndSelectItems` wants the *parent* folder plus the child
        // item; trimming the last id is cheaper than parsing the folder again.
        ILRemoveLastID(pidl);
        let items = [child];
        let opened = SHOpenFolderAndSelectItems(pidl, 1, items.as_ptr(), 0);
        CoTaskMemFree(pidl);
        CoUninitialize();
        if opened < 0 {
            return Err(format!("shell open failed: 0x{:08x}", opened as u32));
        }
    }
    Ok(())
}

/// One mounted drive and how full it is.
pub struct DiskUsage {
    pub name: String,
    pub total: u64,
    pub free: u64,
}

/// Fixed and removable drives with a real capacity (network drives report 0
/// and are skipped; they would only add noise to the widget).
pub fn disk_usage() -> Vec<DiskUsage> {
    let mut out = Vec::new();
    let mask = unsafe { GetLogicalDrives() };
    for index in 0..26u32 {
        if mask & (1 << index) == 0 {
            continue;
        }
        let letter = (b'A' + index as u8) as char;
        let root = format!("{letter}:\\");
        let root_wide = wide(&root);
        let kind = unsafe { GetDriveTypeW(root_wide.as_ptr()) };
        // 2 = removable, 3 = fixed. Skip network (4) and optical (5).
        if kind != 2 && kind != 3 {
            continue;
        }
        let mut free_to_caller = 0u64;
        let mut total = 0u64;
        let mut free_total = 0u64;
        let ok = unsafe {
            GetDiskFreeSpaceExW(
                root_wide.as_ptr(),
                &mut free_to_caller,
                &mut total,
                &mut free_total,
            )
        };
        if ok == 0 || total == 0 {
            continue;
        }
        out.push(DiskUsage {
            name: format!("{letter}:"),
            total,
            free: free_total,
        });
    }
    out
}

/// Seconds since the machine was booted.
pub fn uptime_secs() -> u64 {
    unsafe { GetTickCount64() / 1000 }
}
