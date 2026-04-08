//! Tauri command handlers exposed to the frontend via `invoke`.

use crate::{secure_storage, window};

#[tauri::command]
pub fn secure_session_save(session_json: String) -> Result<(), String> {
  secure_storage::save(&session_json)
}

#[tauri::command]
pub fn secure_session_read() -> Result<Option<String>, String> {
  secure_storage::read()
}

#[tauri::command]
pub fn secure_session_clear() -> Result<(), String> {
  secure_storage::clear()
}

#[tauri::command]
pub fn open_quick_note_window(app: tauri::AppHandle) -> Result<(), String> {
  window::open_new_quick_note_window(&app)
}

#[tauri::command]
pub fn close_quick_note_window(window: tauri::WebviewWindow) -> Result<(), String> {
  window
    .close()
    .map_err(|error| format!("failed to close quick note window: {error}"))
}
