//! Tauri command handlers exposed to the frontend via `invoke`.

use std::{
  fs,
  io::{Read, Write},
  net::{SocketAddr, TcpStream},
  path::{Path, PathBuf},
  process::{Child, Command, Stdio},
  sync::{Mutex, OnceLock},
  time::Duration,
};

use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

use crate::{secure_storage, window};

const DEFAULT_DAEMON_HTTP_PORT: u16 = 35780;
const DAEMON_STATUS_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_DAEMON_STATUS_RESPONSE_BYTES: usize = 1024 * 1024;
const DAEMON_PREFERENCES_FILE: &str = "daemon-preferences.json";
const DEFAULT_DAEMON_SIDECAR_NAME: &str = "workbench-sync-daemon";

struct ManagedDaemon {
  child: Child,
}

struct DaemonCommand {
  program: String,
  args: Vec<String>,
  cwd: PathBuf,
}

static MANAGED_DAEMON: OnceLock<Mutex<Option<ManagedDaemon>>> = OnceLock::new();

fn managed_daemon() -> &'static Mutex<Option<ManagedDaemon>> {
  MANAGED_DAEMON.get_or_init(|| Mutex::new(None))
}

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

fn split_daemon_args(args: &str) -> Vec<String> {
  args.split_whitespace().map(ToString::to_string).collect()
}

fn daemon_args_from_env(name: &str) -> Vec<String> {
  std::env::var(name)
    .ok()
    .map(|value| split_daemon_args(&value))
    .unwrap_or_default()
}

fn has_package_json(path: &Path) -> bool {
  path.join("package.json").is_file()
}

fn has_sync_daemon_workspace(path: &Path) -> bool {
  path
    .join("services")
    .join("sync-daemon")
    .join("package.json")
    .is_file()
}

fn current_exe_parent() -> Option<PathBuf> {
  std::env::current_exe()
    .ok()
    .and_then(|path| path.parent().map(Path::to_path_buf))
}

fn repo_root_candidates() -> Vec<PathBuf> {
  let mut candidates = Vec::new();
  if let Ok(current_dir) = std::env::current_dir() {
    candidates.push(current_dir);
  }
  if let Some(exe_parent) = current_exe_parent() {
    candidates.push(exe_parent);
  }
  candidates
}

fn infer_repo_root() -> PathBuf {
  let candidates = repo_root_candidates();

  for candidate in &candidates {
    for ancestor in candidate.ancestors() {
      if has_package_json(ancestor) && has_sync_daemon_workspace(ancestor) {
        return ancestor.to_path_buf();
      }
    }
  }

  for candidate in &candidates {
    for ancestor in candidate.ancestors() {
      if has_package_json(ancestor) {
        return ancestor.to_path_buf();
      }
    }
  }

  std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn command_cwd_from_program(program: &Path) -> PathBuf {
  program
    .parent()
    .map(Path::to_path_buf)
    .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

fn daemon_executable_names(base_name: &str) -> Vec<String> {
  let trimmed = base_name.trim();
  if trimmed.is_empty() {
    return daemon_executable_names(DEFAULT_DAEMON_SIDECAR_NAME);
  }

  let mut names = vec![trimmed.to_string()];
  #[cfg(target_os = "windows")]
  {
    if !trimmed.to_ascii_lowercase().ends_with(".exe") {
      names.push(format!("{trimmed}.exe"));
    }
  }
  names
}

fn sidecar_search_roots(app: Option<&tauri::AppHandle>) -> Vec<PathBuf> {
  let mut roots = Vec::new();
  if let Some(app) = app {
    if let Ok(resource_dir) = app.path().resource_dir() {
      roots.push(resource_dir);
    }
  }
  if let Some(exe_parent) = current_exe_parent() {
    roots.push(exe_parent);
  }
  if let Ok(current_dir) = std::env::current_dir() {
    roots.push(current_dir);
  }
  roots
}

fn find_packaged_sidecar(app: Option<&tauri::AppHandle>) -> Option<PathBuf> {
  let base_name = std::env::var("WORKBENCH_DAEMON_SIDECAR_NAME")
    .ok()
    .filter(|value| !value.trim().is_empty())
    .unwrap_or_else(|| DEFAULT_DAEMON_SIDECAR_NAME.to_string());
  let names = daemon_executable_names(&base_name);

  for root in sidecar_search_roots(app) {
    for name in &names {
      for candidate in [
        root.join(name),
        root.join("sidecars").join(name),
        root.join("binaries").join(name),
      ] {
        if candidate.is_file() {
          return Some(candidate);
        }
      }
    }
  }

  None
}

fn resolve_explicit_sidecar() -> Result<Option<DaemonCommand>, String> {
  let Ok(raw_path) = std::env::var("WORKBENCH_DAEMON_SIDECAR_PATH") else {
    return Ok(None);
  };
  let trimmed = raw_path.trim();
  if trimmed.is_empty() {
    return Err("WORKBENCH_DAEMON_SIDECAR_PATH was set but empty".to_string());
  }

  let path = PathBuf::from(trimmed);
  if !path.is_file() {
    return Err(format!(
      "WORKBENCH_DAEMON_SIDECAR_PATH does not point to a file: {}",
      path.display()
    ));
  }

  Ok(Some(DaemonCommand {
    program: path_to_string(path.clone()),
    args: daemon_args_from_env("WORKBENCH_DAEMON_SIDECAR_ARGS"),
    cwd: command_cwd_from_program(&path),
  }))
}

fn resolve_packaged_sidecar(app: Option<&tauri::AppHandle>) -> Option<DaemonCommand> {
  let path = find_packaged_sidecar(app)?;
  Some(DaemonCommand {
    program: path_to_string(path.clone()),
    args: daemon_args_from_env("WORKBENCH_DAEMON_SIDECAR_ARGS"),
    cwd: command_cwd_from_program(&path),
  })
}

fn resolve_daemon_command(app: Option<&tauri::AppHandle>) -> Result<DaemonCommand, String> {
  if let Ok(command) = std::env::var("WORKBENCH_DAEMON_COMMAND") {
    let program = command.trim();
    if program.is_empty() {
      return Err("WORKBENCH_DAEMON_COMMAND was set but empty".to_string());
    }

    let args = daemon_args_from_env("WORKBENCH_DAEMON_ARGS");
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));

    return Ok(DaemonCommand {
      program: program.to_string(),
      args,
      cwd,
    });
  }

  if let Some(command) = resolve_explicit_sidecar()? {
    return Ok(command);
  }

  if let Some(command) = resolve_packaged_sidecar(app) {
    return Ok(command);
  }

  let cwd = infer_repo_root();
  let program = if cfg!(target_os = "windows") {
    "npm.cmd"
  } else {
    "npm"
  };

  Ok(DaemonCommand {
    program: program.to_string(),
    args: vec![
      "run".to_string(),
      "dev".to_string(),
      "--workspace".to_string(),
      "services/sync-daemon".to_string(),
    ],
    cwd,
  })
}

fn configure_daemon_env(command: &mut Command) {
  if std::env::var_os("WORKBENCH_DAEMON_HTTP_PORT").is_none() {
    command.env(
      "WORKBENCH_DAEMON_HTTP_PORT",
      DEFAULT_DAEMON_HTTP_PORT.to_string(),
    );
  }
}

fn spawn_daemon(app: Option<&tauri::AppHandle>) -> Result<Child, String> {
  let daemon_command = resolve_daemon_command(app)?;
  let mut command = Command::new(&daemon_command.program);
  command
    .args(&daemon_command.args)
    .current_dir(&daemon_command.cwd)
    .stdin(Stdio::null());
  configure_daemon_env(&mut command);

  command.spawn().map_err(|error| {
    format!(
      "failed to start sync daemon with `{}` from {}: {error}",
      daemon_command.program,
      daemon_command.cwd.display()
    )
  })
}

fn daemon_preferences_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  app
    .path()
    .app_config_dir()
    .map(|path| path.join(DAEMON_PREFERENCES_FILE))
    .map_err(|error| format!("failed to resolve app config directory: {error}"))
}

fn normalize_daemon_preferences(value: serde_json::Value) -> serde_json::Value {
  let auto_start = value
    .get("autoStart")
    .and_then(serde_json::Value::as_bool)
    .unwrap_or(false);
  serde_json::json!({
    "autoStart": auto_start
  })
}

fn read_daemon_preferences_from_disk(app: &tauri::AppHandle) -> Result<serde_json::Value, String> {
  let path = daemon_preferences_path(app)?;
  if !path.is_file() {
    return Ok(normalize_daemon_preferences(serde_json::json!({})));
  }

  let raw = fs::read_to_string(&path)
    .map_err(|error| format!("failed to read daemon preferences {}: {error}", path.display()))?;
  let parsed = serde_json::from_str::<serde_json::Value>(&raw)
    .map_err(|error| format!("failed to parse daemon preferences {}: {error}", path.display()))?;
  Ok(normalize_daemon_preferences(parsed))
}

fn write_daemon_preferences_to_disk(
  app: &tauri::AppHandle,
  preferences: &serde_json::Value,
) -> Result<(), String> {
  let path = daemon_preferences_path(app)?;
  let parent = path
    .parent()
    .ok_or_else(|| format!("daemon preferences path has no parent: {}", path.display()))?;
  fs::create_dir_all(parent)
    .map_err(|error| format!("failed to create daemon preferences directory {}: {error}", parent.display()))?;
  let serialized = serde_json::to_string_pretty(preferences)
    .map_err(|error| format!("failed to serialize daemon preferences: {error}"))?;
  fs::write(&path, format!("{serialized}\n"))
    .map_err(|error| format!("failed to write daemon preferences {}: {error}", path.display()))
}

fn start_daemon_with_app(app: Option<&tauri::AppHandle>) -> Result<bool, String> {
  let mut managed = managed_daemon()
    .lock()
    .map_err(|_| "sync daemon process lock was poisoned".to_string())?;

  if let Some(daemon) = managed.as_mut() {
    match daemon.child.try_wait() {
      Ok(None) => return Ok(false),
      Ok(Some(_status)) => {
        *managed = None;
      }
      Err(error) => return Err(format!("failed to inspect sync daemon process: {error}")),
    }
  }

  let child = spawn_daemon(app)?;
  *managed = Some(ManagedDaemon { child });
  Ok(true)
}

pub fn start_daemon_if_auto_start_enabled(app: &tauri::AppHandle) {
  let preferences = match read_daemon_preferences_from_disk(app) {
    Ok(preferences) => preferences,
    Err(error) => {
      eprintln!("[workbench-native] failed to read daemon preferences: {error}");
      return;
    }
  };

  if !preferences
    .get("autoStart")
    .and_then(serde_json::Value::as_bool)
    .unwrap_or(false)
  {
    return;
  }

  if let Err(error) = start_daemon_with_app(Some(app)) {
    eprintln!("[workbench-native] failed to auto-start sync daemon: {error}");
  }
}

#[cfg(target_os = "windows")]
fn kill_child_process_tree(child: &mut Child) -> Result<(), String> {
  let pid = child.id().to_string();
  let status = Command::new("taskkill")
    .args(["/PID", &pid, "/T", "/F"])
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .status()
    .map_err(|error| format!("failed to invoke taskkill for sync daemon process {pid}: {error}"))?;

  if status.success() {
    return Ok(());
  }

  child
    .kill()
    .map_err(|error| format!("failed to kill sync daemon process {pid}: {error}"))
}

#[cfg(not(target_os = "windows"))]
fn kill_child_process_tree(child: &mut Child) -> Result<(), String> {
  child
    .kill()
    .map_err(|error| format!("failed to kill sync daemon process {}: {error}", child.id()))
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
pub fn read_daemon_preferences(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
  read_daemon_preferences_from_disk(&app)
}

#[tauri::command]
pub fn set_daemon_auto_start(
  app: tauri::AppHandle,
  auto_start: bool,
) -> Result<serde_json::Value, String> {
  let preferences = normalize_daemon_preferences(serde_json::json!({
    "autoStart": auto_start
  }));
  write_daemon_preferences_to_disk(&app, &preferences)?;
  Ok(preferences)
}

#[tauri::command]
pub fn start_daemon(app: tauri::AppHandle) -> Result<bool, String> {
  start_daemon_with_app(Some(&app))
}

#[tauri::command]
pub fn stop_daemon() -> Result<bool, String> {
  let mut managed = managed_daemon()
    .lock()
    .map_err(|_| "sync daemon process lock was poisoned".to_string())?;

  let Some(mut daemon) = managed.take() else {
    return Ok(false);
  };

  if daemon
    .child
    .try_wait()
    .map_err(|error| format!("failed to inspect sync daemon process: {error}"))?
    .is_some()
  {
    return Ok(true);
  }

  kill_child_process_tree(&mut daemon.child)?;
  daemon
    .child
    .wait()
    .map_err(|error| format!("failed to wait for sync daemon shutdown: {error}"))?;
  Ok(true)
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
