//! Native file drag-out for the shelf.
//!
//! A webview cannot start a real Explorer drag: HTML5 drag & drop has no way to
//! hand a file path to another application. Windows does that through OLE —
//! `DoDragDrop` with an `IDataObject` that carries `CF_HDROP`. The shell can
//! build that data object from a PIDL, so the only thing we implement ourselves
//! is the tiny `IDropSource` (it decides when the drag is finished).

use windows::core::{implement, BOOL, PCWSTR};
use windows::Win32::Foundation::{
    DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS, S_OK,
};
use windows::Win32::System::Com::{CoTaskMemFree, IDataObject};
use windows::Win32::System::Ole::{
    DoDragDrop, IDropSource, IDropSource_Impl, OleInitialize, OleUninitialize, DROPEFFECT,
    DROPEFFECT_COPY,
};
use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
use windows::Win32::UI::Shell::Common::ITEMIDLIST;
use windows::Win32::UI::Shell::{
    ILFindLastID, ILRemoveLastID, SHCreateDataObject, SHParseDisplayName,
};

/// Minimal drop source: left button released → drop, Esc → cancel.
#[implement(IDropSource)]
struct FileDropSource;

/// Error text used when the drag was never really started (button already up).
pub const DRAG_CANCELLED: &str = "drag-cancelled";

impl IDropSource_Impl for FileDropSource_Impl {
    fn QueryContinueDrag(
        &self,
        escape_pressed: BOOL,
        key_state: MODIFIERKEYS_FLAGS,
    ) -> windows::core::HRESULT {
        if escape_pressed.as_bool() {
            return DRAGDROP_S_CANCEL;
        }
        // MK_LBUTTON: while it is held the drag continues.
        if key_state.0 & 0x0001 == 0 {
            return DRAGDROP_S_DROP;
        }
        S_OK
    }

    fn GiveFeedback(&self, _effect: DROPEFFECT) -> windows::core::HRESULT {
        DRAGDROP_S_USEDEFAULTCURSORS
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

const VK_LBUTTON: i32 = 0x01;

unsafe extern "system" {
    fn GetAsyncKeyState(vk: i32) -> i16;
}

/// True while the physical left button is down.
fn left_button_down() -> bool {
    // The high bit is set while the key is pressed.
    unsafe { (GetAsyncKeyState(VK_LBUTTON) as u16 & 0x8000) != 0 }
}

/// Blocks until the user drops the file or cancels. Always call it on a worker
/// thread: `DoDragDrop` runs its own modal message loop.
pub fn start_drag(path: &str) -> Result<(), String> {
    if !std::path::Path::new(path).exists() {
        return Err("файл больше не существует".to_string());
    }
    // `DoDragDrop` only checks the button state when it receives mouse input, so
    // without a held button its modal loop never returns. Wait briefly for the
    // press that triggered us (the JS side fires on a 6 px move) and bail out
    // instead of hanging a thread forever.
    let mut waited = 0;
    while !left_button_down() {
        if waited >= 200 {
            return Err(DRAG_CANCELLED.to_string());
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
        waited += 10;
    }
    let name = wide(path);
    unsafe {
        OleInitialize(None).map_err(|err| err.to_string())?;

        let mut pidl: *mut ITEMIDLIST = std::ptr::null_mut();
        if let Err(err) = SHParseDisplayName(PCWSTR(name.as_ptr()), None, &mut pidl, 0, None) {
            OleUninitialize();
            return Err(err.to_string());
        }
        if pidl.is_null() {
            OleUninitialize();
            return Err("не удалось разобрать путь".to_string());
        }

        let child = ILFindLastID(pidl);
        // `SHCreateDataObject` wants the parent folder plus the item itself.
        let _ = ILRemoveLastID(Some(pidl));
        let items = [child as *const ITEMIDLIST];

        let result = (|| -> Result<(), String> {
            let data: IDataObject = SHCreateDataObject(Some(pidl), Some(&items), None::<&IDataObject>)
                .map_err(|err| err.to_string())?;
            let source: IDropSource = FileDropSource.into();
            let mut effect = DROPEFFECT_COPY;
            // Copy only: a shelf must never move the original away by accident.
            let _ = DoDragDrop(&data, &source, DROPEFFECT_COPY, &mut effect);
            Ok(())
        })();

        CoTaskMemFree(Some(pidl as *const _));
        OleUninitialize();
        result
    }
}
