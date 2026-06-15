//! Tauri command handlers exposed to the frontend via `invoke`.

use std::{
  io::{Read, Write},
  net::{SocketAddr, TcpStream},
  path::PathBuf,
  time::Duration,
};

use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

use crate::{secure_storage, window};

const DEFAULT_DAEMON_HTTP_PORT: u16 = 35780;
const DAEMON_STATUS_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_DAEMON_STATUS_RESPONSE_BYTES: usize = 1024 * 1024;

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

fn path_to_string(path: PathBuf) -> String {
  path.to_string_lossy().into_owned()
}

fn env_path(name: &str) -> Option<PathBuf> {
  std::env::var(name)
    .ok()
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty())
    .map(PathBuf::from)
}

fn default_sync_folder(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  if let Some(path) = env_path("WORKBENCH_SYNC_ROOT") {
    return Ok(path);
  }

  app
    .path()
    .home_dir()
    .map(|path| path.join("WorkbenchSync"))
    .map_err(|error| format!("failed to resolve home directory: {error}"))
}

fn default_downloads_folder(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  if let Some(path) = env_path("WORKBENCH_DOWNLOADS_DIR") {
    return Ok(path);
  }

  app
    .path()
    .download_dir()
    .or_else(|_| app.path().home_dir().map(|path| path.join("Downloads")))
    .map_err(|error| format!("failed to resolve downloads directory: {error}"))
}

fn ensure_folder_and_open(path: PathBuf) -> Result<bool, String> {
  std::fs::create_dir_all(&path)
    .map_err(|error| format!("failed to create folder {}: {error}", path.display()))?;
  open_with_default_app(&path)?;
  Ok(true)
}

fn configured_daemon_port(port: Option<u16>) -> Result<u16, String> {
  if let Some(port) = port {
    if port == 0 {
      return Err("sync daemon status port cannot be 0".to_string());
    }
    return Ok(port);
  }

  match std::env::var("WORKBENCH_DAEMON_HTTP_PORT") {
    Ok(value) => {
      let trimmed = value.trim();
      if trimmed.is_empty() {
        return Ok(DEFAULT_DAEMON_HTTP_PORT);
      }

      let parsed = trimmed.parse::<u16>().map_err(|_| {
        format!("WORKBENCH_DAEMON_HTTP_PORT must be between 1 and 65535, got {trimmed}")
      })?;
      if parsed == 0 {
        Err("sync daemon status server is disabled because WORKBENCH_DAEMON_HTTP_PORT=0".to_string())
      } else {
        Ok(parsed)
      }
    }
    Err(_) => Ok(DEFAULT_DAEMON_HTTP_PORT),
  }
}

fn read_loopback_status(port: u16) -> Result<serde_json::Value, String> {
  let address = SocketAddr::from(([127, 0, 0, 1], port));
  let mut stream = TcpStream::connect_timeout(&address, DAEMON_STATUS_TIMEOUT)
    .map_err(|error| format!("failed to connect to sync daemon at {address}: {error}"))?;

  stream
    .set_read_timeout(Some(DAEMON_STATUS_TIMEOUT))
    .map_err(|error| format!("failed to set daemon status read timeout: {error}"))?;
  stream
    .set_write_timeout(Some(DAEMON_STATUS_TIMEOUT))
    .map_err(|error| format!("failed to set daemon status write timeout: {error}"))?;

  let request = format!(
    "GET /status HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
  );
  stream
    .write_all(request.as_bytes())
    .map_err(|error| format!("failed to request sync daemon status: {error}"))?;

  let mut response = Vec::new();
  let mut chunk = [0_u8; 8192];
  loop {
    let bytes_read = stream
      .read(&mut chunk)
      .map_err(|error| format!("failed to read sync daemon status: {error}"))?;
    if bytes_read == 0 {
      break;
    }
    response.extend_from_slice(&chunk[..bytes_read]);
    if response.len() > MAX_DAEMON_STATUS_RESPONSE_BYTES {
      return Err("sync daemon status response is too large".to_string());
    }
  }

  let response_text = String::from_utf8(response)
    .map_err(|error| format!("sync daemon status response was not UTF-8: {error}"))?;
  let (headers, body) = response_text
    .split_once("\r\n\r\n")
    .ok_or_else(|| "sync daemon status response was malformed".to_string())?;

  let status_line = headers
    .lines()
    .next()
    .ok_or_else(|| "sync daemon status response did not include a status line".to_string())?;
  let status_code = status_line
    .split_whitespace()
    .nth(1)
    .ok_or_else(|| format!("sync daemon status line was malformed: {status_line}"))?;

  if status_code != "200" {
    let detail = body.trim();
    if detail.is_empty() {
      return Err(format!("sync daemon status request failed with HTTP {status_code}"));
    }
    return Err(format!(
      "sync daemon status request failed with HTTP {status_code}: {detail}"
    ));
  }

  serde_json::from_str(body.trim())
    .map_err(|error| format!("failed to parse sync daemon status JSON: {error}"))
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

#[tauri::command]
pub async fn choose_sync_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
  let path = app.dialog().file().blocking_pick_folder();

  match path {
    Some(folder_path) => folder_path
      .into_path()
      .map(path_to_string)
      .map(Some)
      .map_err(|error| format!("invalid folder path: {error}")),
    None => Ok(None),
  }
}

#[tauri::command]
pub fn open_sync_folder(app: tauri::AppHandle) -> Result<bool, String> {
  ensure_folder_and_open(default_sync_folder(&app)?)
}

#[tauri::command]
pub fn open_downloads_folder(app: tauri::AppHandle) -> Result<bool, String> {
  ensure_folder_and_open(default_downloads_folder(&app)?)
}

#[tauri::command]
pub fn read_daemon_status(port: Option<u16>) -> Result<serde_json::Value, String> {
  read_loopback_status(configured_daemon_port(port)?)
}

#[tauri::command]
pub fn start_daemon() -> Result<(), String> {
  Err(
    "sync-daemon sidecar is not configured for this Tauri app yet; start it with npm run dev --workspace services/sync-daemon for now"
      .to_string(),
  )
}

#[tauri::command]
pub fn stop_daemon() -> Result<(), String> {
  Err(
    "sync-daemon sidecar/process management is not configured for this Tauri app yet; stop the external daemon process manually"
      .to_string(),
  )
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
