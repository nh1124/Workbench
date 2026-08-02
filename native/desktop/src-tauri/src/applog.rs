//! A log file for the desktop app itself.
//!
//! Release builds are windows-subsystem, so they have no console and `eprintln!` goes
//! nowhere. That left three rounds of diagnosing a blank window by reasoning alone, each
//! time fixing something real and each time still guessing. This writes the same messages
//! somewhere they can be read.
//!
//! It lives beside the daemon's log, in the config directory shared by every variant, so
//! one file covers whichever app produced the entry.

use std::fmt::Write as _;
use std::fs::OpenOptions;
use std::io::Write as _;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const APP_LOG_FILE: &str = "workbench-native.log";
/// Truncated past this so a long-running install cannot fill a disk.
const MAX_LOG_BYTES: u64 = 1_000_000;

fn log_lock() -> &'static Mutex<()> {
  static LOCK: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
  LOCK.get_or_init(|| Mutex::new(()))
}

pub fn log_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
  crate::variant::shared_config_directory(app).map(|dir| dir.join(APP_LOG_FILE))
}

/// Appends one line. Never fails loudly: logging must not become its own incident.
pub fn write(app: &tauri::AppHandle, source: &str, message: &str) {
  let Ok(path) = log_path(app) else { return };
  let Ok(_guard) = log_lock().lock() else { return };

  if let Some(parent) = path.parent() {
    let _ = std::fs::create_dir_all(parent);
  }
  if std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0) > MAX_LOG_BYTES {
    let _ = std::fs::remove_file(&path);
  }

  let millis = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|value| value.as_millis())
    .unwrap_or(0);
  let mut line = String::new();
  let variant = crate::variant::current(app).name();
  let _ = writeln!(line, "[{millis}] [{variant}] [{source}] {message}");

  if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
    let _ = file.write_all(line.as_bytes());
  }
}

/// Records an error the webview could not otherwise report.
///
/// A page that throws before it renders leaves a blank window and no trace at all, which is
/// indistinguishable from a window that never loaded.
#[tauri::command]
pub fn log_ui_error(app: tauri::AppHandle, message: String) {
  write(&app, "webview", &message);
}

#[tauri::command]
pub fn open_app_log(app: tauri::AppHandle) -> Result<bool, String> {
  let path = log_path(&app)?;
  if !path.is_file() {
    return Err(format!("no app log yet at {}", path.display()));
  }
  crate::commands::open_text_file(&path)?;
  Ok(true)
}
