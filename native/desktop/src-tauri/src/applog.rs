//! This app's view of the shared log file.
//!
//! The writing itself lives in `workbench_shared::log`, because the resident writes to the
//! same file and the two must agree on its location and format. What is left here is the
//! app-shaped part: naming this process by its variant, and the commands the webview calls.

/// Names this process in the log before anything else writes a line.
pub fn name_this_process(app: &tauri::AppHandle) {
  workbench_shared::log::set_process_tag(crate::variant::current(app).name());
}

/// Appends one line. The handle is taken for the sake of callers that already hold one and
/// to keep the call sites unchanged; the tag comes from [`name_this_process`].
pub fn write(_app: &tauri::AppHandle, source: &str, message: &str) {
  workbench_shared::log::write(source, message);
}

pub fn log_path() -> Result<std::path::PathBuf, String> {
  workbench_shared::log::path()
}

/// Records an error the webview could not otherwise report.
///
/// A page that throws before it renders leaves a blank window and no trace at all, which is
/// indistinguishable from a window that never loaded.
#[tauri::command]
pub fn log_ui_error(message: String) {
  workbench_shared::log::write("webview", &message);
}

#[tauri::command]
pub fn open_app_log() -> Result<bool, String> {
  let path = log_path()?;
  if !path.is_file() {
    return Err(format!("no app log yet at {}", path.display()));
  }
  crate::commands::open_text_file(&path)?;
  Ok(true)
}
