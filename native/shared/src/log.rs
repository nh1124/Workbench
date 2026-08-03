//! One log file for every Workbench process on the machine.
//!
//! Release builds are windows-subsystem, so they have no console and `eprintln!` goes
//! nowhere. That left three rounds of diagnosing a blank window by reasoning alone, each
//! time fixing something real and each time still guessing.
//!
//! It is deliberately one file rather than one per process. The questions worth asking span
//! processes now that the resident owns the shortcuts and the apps own the windows — "the
//! shortcut fired, did an app ever start?" cannot be answered from two logs whose clocks and
//! ordering you have to reconcile by hand.

use std::fmt::Write as _;
use std::fs::OpenOptions;
use std::io::Write as _;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const APP_LOG_FILE: &str = "workbench-native.log";
/// Truncated past this so a resident that runs for months cannot fill a disk.
const MAX_LOG_BYTES: u64 = 1_000_000;

fn log_lock() -> &'static Mutex<()> {
  static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
  LOCK.get_or_init(|| Mutex::new(()))
}

fn process_tag() -> &'static OnceLock<String> {
  static TAG: OnceLock<String> = OnceLock::new();
  &TAG
}

/// Names the process in every line it writes: `main`, `tasks`, `resident`, and so on.
///
/// Set once at startup. Calling it again is ignored rather than an error — a second call
/// means two places tried to name the process, and the first one is as good an answer as any.
pub fn set_process_tag(tag: &str) {
  let _ = process_tag().set(tag.to_string());
}

pub fn path() -> Result<std::path::PathBuf, String> {
  crate::paths::shared_config_directory().map(|dir| dir.join(APP_LOG_FILE))
}

/// Appends one line. Never fails loudly: logging must not become its own incident.
///
/// Several processes append to this file at once. Each opens in append mode, so a single
/// `write_all` lands whole rather than interleaved; the mutex only orders this process.
pub fn write(source: &str, message: &str) {
  let Ok(path) = path() else { return };
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
  let tag = process_tag().get().map(String::as_str).unwrap_or("unknown");
  let mut line = String::new();
  let _ = writeln!(line, "[{millis}] [{tag}] [{source}] {message}");

  if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
    let _ = file.write_all(line.as_bytes());
  }
}
