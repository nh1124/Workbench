//! Tauri command handlers exposed to the frontend via `invoke`.

use tauri_plugin_dialog::DialogExt;

use crate::{secure_storage, window};

fn sanitize_temp_filename(default_name: &str) -> String {
  let trimmed = default_name.trim();
  let fallback = "document.docx";
  let source = if trimmed.is_empty() { fallback } else { trimmed };
  let sanitized: String = source
    .chars()
    .map(|ch| match ch {
      '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
      c if c.is_control() => '_',
      c => c,
    })
    .collect();
  if sanitized.trim().is_empty() {
    fallback.to_string()
  } else {
    sanitized
  }
}

fn open_with_default_app(path: &std::path::Path) -> Result<(), String> {
  #[cfg(target_os = "windows")]
  {
    std::process::Command::new("cmd")
      .arg("/C")
      .arg("start")
      .arg("")
      .arg(path.as_os_str())
      .spawn()
      .map_err(|error| format!("failed to open file with default app: {error}"))?;
    return Ok(());
  }

  #[cfg(target_os = "macos")]
  {
    std::process::Command::new("open")
      .arg(path.as_os_str())
      .spawn()
      .map_err(|error| format!("failed to open file with default app: {error}"))?;
    return Ok(());
  }

  #[cfg(all(unix, not(target_os = "macos")))]
  {
    std::process::Command::new("xdg-open")
      .arg(path.as_os_str())
      .spawn()
      .map_err(|error| format!("failed to open file with default app: {error}"))?;
    return Ok(());
  }

  #[allow(unreachable_code)]
  Err("opening files is not supported on this platform".to_string())
}

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

/// Open a native Save-As dialog and write `bytes` to the chosen path.
/// Returns `true` if saved, `false` if the user cancelled.
#[tauri::command]
pub async fn save_file_with_dialog(
  app: tauri::AppHandle,
  bytes: Vec<u8>,
  default_name: String,
) -> Result<bool, String> {
  let path = app
    .dialog()
    .file()
    .set_file_name(&default_name)
    .blocking_save_file();

  match path {
    Some(file_path) => {
      let path_buf = file_path
        .into_path()
        .map_err(|e| format!("invalid path: {e}"))?;
      std::fs::write(&path_buf, &bytes)
        .map_err(|e| format!("failed to write file: {e}"))?;
      Ok(true)
    }
    None => Ok(false), // user cancelled
  }
}

/// Save a temporary file and ask the OS to open it with the default associated app.
#[tauri::command]
pub fn open_file_in_os_app(bytes: Vec<u8>, default_name: String) -> Result<bool, String> {
  let temp_dir = std::env::temp_dir().join("workbench-open");
  std::fs::create_dir_all(&temp_dir)
    .map_err(|error| format!("failed to create temp directory: {error}"))?;

  let ts = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|value| value.as_millis())
    .unwrap_or(0);

  let file_name = format!("{ts}-{}", sanitize_temp_filename(&default_name));
  let file_path = temp_dir.join(file_name);
  std::fs::write(&file_path, &bytes)
    .map_err(|error| format!("failed to write temp file: {error}"))?;

  open_with_default_app(&file_path)?;
  Ok(true)
}
