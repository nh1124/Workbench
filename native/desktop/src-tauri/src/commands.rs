//! Tauri command handlers exposed to the frontend via `invoke`.

use std::{
  fs,
  io::{Read, Write},
  net::{SocketAddr, TcpStream},
  path::{Path, PathBuf},
  process::{Child, Command, Stdio},
  sync::{Mutex, OnceLock},
  time::{Duration, Instant},
};

use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

use crate::{daemon_guard, secure_storage, window};

const DEFAULT_DAEMON_HTTP_PORT: u16 = 35780;
const DAEMON_STATUS_TIMEOUT: Duration = Duration::from_secs(2);
const DAEMON_READINESS_POLL_INTERVAL: Duration = Duration::from_millis(250);
const DAEMON_READINESS_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_DAEMON_STATUS_RESPONSE_BYTES: usize = 1024 * 1024;
const DAEMON_PREFERENCES_FILE: &str = "daemon-preferences.json";
const DAEMON_LOG_FILE: &str = "sync-daemon.log";
/// `CREATE_NO_WINDOW` — keeps the console sidecar from flashing up a console window.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const DEFAULT_DAEMON_SIDECAR_NAME: &str = "workbench-sync-daemon";
const LOCAL_CLIENT_ID_ENV: &str = "WORKBENCH_LOCAL_CLIENT_ID";
const LOCAL_CLIENT_TOKEN_ENV: &str = "WORKBENCH_LOCAL_CLIENT_TOKEN";
const PERSIST_CLIENT_IDENTITY_ENV: &str = "WORKBENCH_PERSIST_CLIENT_IDENTITY";
const SECURE_CLIENT_IDENTITY_ENV: &str = "WORKBENCH_SECURE_CLIENT_IDENTITY";
const CORE_URL_ENV: &str = "WORKBENCH_CORE_URL";

#[derive(Debug, Clone)]
struct ActiveWorkbenchAccount {
  user_id: String,
  username: String,
  access_token: Option<String>,
}

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
  let source = if trimmed.is_empty() {
    fallback
  } else {
    trimmed
  };
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

fn parse_active_workbench_account(raw: &str) -> Option<ActiveWorkbenchAccount> {
  let parsed = serde_json::from_str::<serde_json::Value>(raw).ok()?;
  let user = parsed.get("user")?;
  let user_id = user
    .get("id")
    .and_then(serde_json::Value::as_str)
    .map(str::trim)
    .filter(|value| !value.is_empty())?
    .to_string();
  let username = user
    .get("username")
    .and_then(serde_json::Value::as_str)
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .unwrap_or("user")
    .to_string();
  let access_token = parsed
    .get("accessToken")
    .and_then(serde_json::Value::as_str)
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(ToString::to_string);

  Some(ActiveWorkbenchAccount {
    user_id,
    username,
    access_token,
  })
}

fn active_workbench_account() -> Option<ActiveWorkbenchAccount> {
  secure_storage::read()
    .ok()
    .flatten()
    .and_then(|raw| parse_active_workbench_account(&raw))
}

fn sanitize_folder_segment(raw: &str) -> String {
  let mut sanitized = String::new();
  let mut previous_separator = false;
  for ch in raw.trim().chars() {
    let replacement = match ch {
      '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => Some('_'),
      c if c.is_control() => Some('_'),
      c if c.is_whitespace() => Some('-'),
      c => Some(c),
    };
    let Some(next) = replacement else {
      continue;
    };
    let is_separator = next == '_' || next == '-' || next == '.';
    if is_separator && previous_separator {
      continue;
    }
    sanitized.push(next);
    previous_separator = is_separator;
    if sanitized.chars().count() >= 64 {
      break;
    }
  }

  let trimmed = sanitized
    .trim_matches(|ch| ch == '_' || ch == '-' || ch == '.')
    .to_string();
  if trimmed.is_empty() {
    "user".to_string()
  } else {
    trimmed
  }
}

fn take_segment_prefix(raw: &str, max_chars: usize) -> String {
  raw.chars().take(max_chars).collect()
}

fn account_folder_segment(account: Option<&ActiveWorkbenchAccount>) -> String {
  let Some(account) = account else {
    return "guest".to_string();
  };
  let username = sanitize_folder_segment(&account.username);
  let user_id = sanitize_folder_segment(&account.user_id);
  format!("{}-{}", username, take_segment_prefix(&user_id, 12))
}

fn account_sync_root_id(account: Option<&ActiveWorkbenchAccount>) -> String {
  let Some(account) = account else {
    return "guest".to_string();
  };
  format!(
    "account-{}",
    take_segment_prefix(&sanitize_folder_segment(&account.user_id), 32)
  )
}

fn account_label(account: Option<&ActiveWorkbenchAccount>) -> String {
  account
    .map(|account| account.username.trim())
    .filter(|value| !value.is_empty())
    .unwrap_or("Guest")
    .to_string()
}

fn default_sync_folder(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  if let Some(path) = env_path("WORKBENCH_SYNC_ROOT") {
    return Ok(path);
  }

  let account = active_workbench_account();
  let account_segment = account_folder_segment(account.as_ref());
  app
    .path()
    .home_dir()
    .map(|path| path.join("WorkbenchSync").join(account_segment))
    .map_err(|error| format!("failed to resolve home directory: {error}"))
}

fn default_downloads_folder(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  if let Some(path) = env_path("WORKBENCH_DOWNLOADS_DIR") {
    return Ok(path);
  }

  let account = active_workbench_account();
  let account_segment = account_folder_segment(account.as_ref());
  app
    .path()
    .download_dir()
    .or_else(|_| app.path().home_dir().map(|path| path.join("Downloads")))
    .map(|path| path.join("Workbench").join(account_segment))
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
        Err(
          "sync daemon status server is disabled because WORKBENCH_DAEMON_HTTP_PORT=0".to_string(),
        )
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
      return Err(format!(
        "sync daemon status request failed with HTTP {status_code}"
      ));
    }
    return Err(format!(
      "sync daemon status request failed with HTTP {status_code}: {detail}"
    ));
  }

  serde_json::from_str(body.trim())
    .map_err(|error| format!("failed to parse sync daemon status JSON: {error}"))
}

fn daemon_is_running_externally() -> bool {
  let Ok(port) = configured_daemon_port(None) else {
    return false;
  };
  read_loopback_status(port).is_ok()
}

fn wait_for_daemon_readiness_with<P, S, N>(
  poll_interval: Duration,
  timeout: Duration,
  mut probe: P,
  mut sleep: S,
  mut now: N,
) -> bool
where
  P: FnMut() -> bool,
  S: FnMut(Duration),
  N: FnMut() -> Instant,
{
  let started = now();
  loop {
    if now().saturating_duration_since(started) >= timeout {
      return false;
    }
    if probe() {
      return true;
    }

    let elapsed = now().saturating_duration_since(started);
    if elapsed >= timeout {
      return false;
    }
    sleep(poll_interval.min(timeout.saturating_sub(elapsed)));
  }
}

fn wait_for_daemon_readiness() -> bool {
  wait_for_daemon_readiness_with(
    DAEMON_READINESS_POLL_INTERVAL,
    DAEMON_READINESS_TIMEOUT,
    daemon_is_running_externally,
    std::thread::sleep,
    Instant::now,
  )
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

fn configure_daemon_env(
  command: &mut Command,
  app: Option<&tauri::AppHandle>,
) -> Result<(), String> {
  let mut sync_root_for_identity: Option<PathBuf> = None;
  let mut configured_core_url: Option<String> = None;
  let active_account = active_workbench_account();
  if std::env::var_os("WORKBENCH_DAEMON_HTTP_PORT").is_none() {
    command.env(
      "WORKBENCH_DAEMON_HTTP_PORT",
      DEFAULT_DAEMON_HTTP_PORT.to_string(),
    );
  }

  if let Some(app) = app {
    let preferences = read_daemon_preferences_from_disk(app)?;
    configured_core_url = configured_daemon_core_url(&preferences);
    let sync_root = configured_sync_folder(app, &preferences)?;
    let downloads_dir = configured_downloads_folder(app, &preferences)?;
    sync_root_for_identity = Some(sync_root.clone());
    command.env("WORKBENCH_SYNC_ROOT", path_to_string(sync_root));
    command.env("WORKBENCH_DOWNLOADS_DIR", path_to_string(downloads_dir));
  }

  if std::env::var_os(CORE_URL_ENV).is_none() {
    if let Some(core_url) = configured_core_url {
      command.env(CORE_URL_ENV, core_url);
    }
  }

  if std::env::var_os("WORKBENCH_ACCESS_TOKEN").is_none() {
    if let Some(access_token) = active_account
      .as_ref()
      .and_then(|account| account.access_token.as_ref())
    {
      command.env("WORKBENCH_ACCESS_TOKEN", access_token);
    }
  }
  if std::env::var_os("WORKBENCH_SYNC_ROOT_ID").is_none() {
    command.env(
      "WORKBENCH_SYNC_ROOT_ID",
      account_sync_root_id(active_account.as_ref()),
    );
  }
  if std::env::var_os("WORKBENCH_SYNC_ROOT_LABEL").is_none() {
    command.env(
      "WORKBENCH_SYNC_ROOT_LABEL",
      format!(
        "Workbench Sync ({})",
        account_label(active_account.as_ref())
      ),
    );
  }
  if std::env::var_os(SECURE_CLIENT_IDENTITY_ENV).is_none() {
    command.env(SECURE_CLIENT_IDENTITY_ENV, "auto");
  }

  configure_daemon_client_identity_env(
    command,
    sync_root_for_identity.as_deref(),
    active_account.as_ref(),
  );
  Ok(())
}

fn configure_daemon_client_identity_env(
  command: &mut Command,
  sync_root: Option<&Path>,
  active_account: Option<&ActiveWorkbenchAccount>,
) {
  let has_parent_client_id = std::env::var_os(LOCAL_CLIENT_ID_ENV).is_some();
  let has_parent_client_token = std::env::var_os(LOCAL_CLIENT_TOKEN_ENV).is_some();

  if has_parent_client_id && has_parent_client_token {
    if std::env::var_os(PERSIST_CLIENT_IDENTITY_ENV).is_none() {
      command.env(PERSIST_CLIENT_IDENTITY_ENV, "0");
    }
    return;
  }

  if has_parent_client_id || has_parent_client_token {
    eprintln!(
      "[workbench-native] not injecting secure local daemon client credentials because parent env is incomplete"
    );
    return;
  }

  if active_account.is_some() {
    let _ = sync_root;
    return;
  }

  match secure_storage::read_local_daemon_client_identity() {
    Ok(Some(identity)) => {
      command.env(LOCAL_CLIENT_ID_ENV, identity.local_client_id);
      command.env(LOCAL_CLIENT_TOKEN_ENV, identity.local_client_token);
      if std::env::var_os(PERSIST_CLIENT_IDENTITY_ENV).is_none() {
        command.env(PERSIST_CLIENT_IDENTITY_ENV, "0");
      }
    }
    Ok(None) => {
      let Some(sync_root) = sync_root else {
        return;
      };
      match migrate_local_daemon_identity_file_to_secure_storage(sync_root) {
        Ok(Some(identity)) => {
          command.env(LOCAL_CLIENT_ID_ENV, identity.local_client_id);
          command.env(LOCAL_CLIENT_TOKEN_ENV, identity.local_client_token);
          if std::env::var_os(PERSIST_CLIENT_IDENTITY_ENV).is_none() {
            command.env(PERSIST_CLIENT_IDENTITY_ENV, "0");
          }
        }
        Ok(None) => {}
        Err(error) => {
          eprintln!(
            "[workbench-native] failed to migrate local daemon client credentials; daemon will use file fallback: {error}"
          );
        }
      }
    }
    Err(error) => {
      eprintln!(
        "[workbench-native] failed to read secure local daemon client credentials; daemon will use file fallback: {error}"
      );
    }
  }
}

/// Path the daemon's console output is captured to, so it can be reviewed without a
/// console window ever appearing.
pub fn daemon_log_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  app
    .path()
    .app_config_dir()
    .map(|path| path.join(DAEMON_LOG_FILE))
    .map_err(|error| format!("failed to resolve app config directory: {error}"))
}

/// Redirects the daemon's stdout/stderr into the log file, truncating what was there.
///
/// Returns `None` when the log cannot be opened; the caller then falls back to discarding
/// output rather than letting it reach a console.
fn daemon_log_sinks(app: Option<&tauri::AppHandle>) -> Option<(Stdio, Stdio)> {
  let path = app.and_then(|app| daemon_log_path(app).ok())?;
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).ok()?;
  }

  let file = fs::File::create(&path)
    .map_err(|error| {
      eprintln!(
        "[workbench-native] failed to open sync daemon log {}: {error}",
        path.display()
      );
    })
    .ok()?;
  let stderr = file
    .try_clone()
    .map_err(|error| {
      eprintln!("[workbench-native] failed to duplicate sync daemon log handle: {error}");
    })
    .ok()?;
  Some((Stdio::from(file), Stdio::from(stderr)))
}

fn spawn_daemon(app: Option<&tauri::AppHandle>) -> Result<Child, String> {
  let daemon_command = resolve_daemon_command(app)?;
  let mut command = Command::new(&daemon_command.program);
  command
    .args(&daemon_command.args)
    .current_dir(&daemon_command.cwd)
    .stdin(Stdio::null());

  // The sidecar is a console executable. Spawned from a GUI app it would pop up a console
  // window, so suppress it and send the output to a log file instead.
  #[cfg(target_os = "windows")]
  {
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NO_WINDOW);
  }

  match daemon_log_sinks(app) {
    Some((stdout, stderr)) => {
      command.stdout(stdout).stderr(stderr);
    }
    None => {
      command.stdout(Stdio::null()).stderr(Stdio::null());
    }
  }

  configure_daemon_env(&mut command, app)?;

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

fn normalized_optional_path_string(value: &serde_json::Value, key: &str) -> Option<String> {
  value
    .get(key)
    .and_then(serde_json::Value::as_str)
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(|value| path_to_string(PathBuf::from(value)))
}

fn normalize_daemon_core_url(raw: &str) -> Result<String, String> {
  let trimmed = raw.trim();
  if trimmed.is_empty() {
    return Err("Core URL is required.".to_string());
  }
  if trimmed.chars().any(char::is_whitespace) {
    return Err("Core URL must not contain whitespace.".to_string());
  }
  if trimmed.starts_with("https://") {
    return Ok(trimmed.trim_end_matches('/').to_string());
  }
  if trimmed.starts_with("http://") {
    if is_loopback_core_url(trimmed) {
      return Ok(trimmed.trim_end_matches('/').to_string());
    }
    return Err("Core URL must use https:// unless it points to localhost.".to_string());
  }
  Err("Core URL must start with http:// or https://.".to_string())
}

fn is_loopback_core_url(raw: &str) -> bool {
  let Some(hostname) = http_url_hostname(raw) else {
    return false;
  };
  let hostname = hostname
    .trim_matches(|ch| ch == '[' || ch == ']')
    .to_ascii_lowercase();
  hostname == "localhost"
    || hostname == "127.0.0.1"
    || hostname == "::1"
    || hostname == "tauri.localhost"
    || hostname.ends_with(".localhost")
}

fn http_url_hostname(raw: &str) -> Option<String> {
  let rest = raw.strip_prefix("http://")?;
  let authority = rest
    .split(|ch| ch == '/' || ch == '?' || ch == '#')
    .next()
    .unwrap_or("");
  if authority.is_empty() || authority.contains('@') {
    return None;
  }
  if let Some(stripped) = authority.strip_prefix('[') {
    let end = stripped.find(']')?;
    return Some(stripped[..end].to_string());
  }
  authority
    .split(':')
    .next()
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(ToString::to_string)
}

fn normalized_optional_url_string(value: &serde_json::Value, key: &str) -> Option<String> {
  value
    .get(key)
    .and_then(serde_json::Value::as_str)
    .and_then(|value| normalize_daemon_core_url(value).ok())
}

fn normalize_daemon_preferences(value: serde_json::Value) -> serde_json::Value {
  let auto_start = value
    .get("autoStart")
    .and_then(serde_json::Value::as_bool)
    .unwrap_or(false);
  let resident_mode = value
    .get("residentMode")
    .and_then(serde_json::Value::as_bool)
    .unwrap_or(true);
  serde_json::json!({
    "autoStart": auto_start,
    "residentMode": resident_mode,
    "syncRoot": normalized_optional_path_string(&value, "syncRoot"),
    "downloadsDir": normalized_optional_path_string(&value, "downloadsDir"),
    "syncRootBase": normalized_optional_path_string(&value, "syncRootBase"),
    "downloadsDirBase": normalized_optional_path_string(&value, "downloadsDirBase"),
    "coreUrl": normalized_optional_url_string(&value, "coreUrl")
  })
}

fn configured_preference_path(preferences: &serde_json::Value, key: &str) -> Option<PathBuf> {
  preferences
    .get(key)
    .and_then(serde_json::Value::as_str)
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(PathBuf::from)
}

fn configured_sync_folder(
  app: &tauri::AppHandle,
  preferences: &serde_json::Value,
) -> Result<PathBuf, String> {
  if let Some(base) = configured_preference_path(preferences, "syncRootBase") {
    let account = active_workbench_account();
    return Ok(base.join(account_folder_segment(account.as_ref())));
  }

  configured_preference_path(preferences, "syncRoot")
    .map(Ok)
    .unwrap_or_else(|| default_sync_folder(app))
}

fn configured_downloads_folder(
  app: &tauri::AppHandle,
  preferences: &serde_json::Value,
) -> Result<PathBuf, String> {
  if let Some(base) = configured_preference_path(preferences, "downloadsDirBase") {
    let account = active_workbench_account();
    return Ok(base.join(account_folder_segment(account.as_ref())));
  }

  configured_preference_path(preferences, "downloadsDir")
    .map(Ok)
    .unwrap_or_else(|| default_downloads_folder(app))
}

fn configured_daemon_core_url(preferences: &serde_json::Value) -> Option<String> {
  preferences
    .get("coreUrl")
    .and_then(serde_json::Value::as_str)
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(ToString::to_string)
}

fn effective_daemon_core_url(preferences: &serde_json::Value) -> Option<String> {
  configured_daemon_core_url(preferences).or_else(|| {
    std::env::var(CORE_URL_ENV)
      .ok()
      .and_then(|value| normalize_daemon_core_url(&value).ok())
  })
}

fn local_daemon_identity_file(sync_root: &Path) -> PathBuf {
  sync_root.join(".workbench").join("client-identity.json")
}

fn read_local_daemon_identity_file(
  sync_root: &Path,
) -> Result<Option<secure_storage::LocalDaemonClientIdentity>, String> {
  let path = local_daemon_identity_file(sync_root);
  if !path.is_file() {
    return Ok(None);
  }
  let raw = fs::read_to_string(&path).map_err(|error| {
    format!(
      "failed to read local daemon identity file {}: {error}",
      path.display()
    )
  })?;
  secure_storage::parse_local_daemon_client_identity(&raw).map(Some)
}

fn migrate_local_daemon_identity_file_to_secure_storage(
  sync_root: &Path,
) -> Result<Option<secure_storage::LocalDaemonClientIdentity>, String> {
  if !secure_storage::is_supported() {
    return Ok(None);
  }
  let Some(identity) = read_local_daemon_identity_file(sync_root)? else {
    return Ok(None);
  };

  secure_storage::save_local_daemon_client_identity(
    &identity.local_client_id,
    &identity.local_client_token,
  )?;

  let path = local_daemon_identity_file(sync_root);
  match fs::remove_file(&path) {
    Ok(()) => {}
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
    Err(error) => {
      eprintln!(
        "[workbench-native] migrated local daemon client credentials to secure storage, but failed to remove {}: {error}",
        path.display()
      );
    }
  }

  Ok(Some(identity))
}

fn daemon_preferences_response(
  app: &tauri::AppHandle,
  preferences: serde_json::Value,
) -> Result<serde_json::Value, String> {
  let effective_sync_root = configured_sync_folder(app, &preferences)?;
  let effective_downloads_dir = configured_downloads_folder(app, &preferences)?;
  let active_account = active_workbench_account();
  let mut response = preferences.as_object().cloned().unwrap_or_default();
  response.insert(
    "effectiveSyncRoot".to_string(),
    serde_json::Value::String(path_to_string(effective_sync_root)),
  );
  response.insert(
    "effectiveDownloadsDir".to_string(),
    serde_json::Value::String(path_to_string(effective_downloads_dir)),
  );
  response.insert(
    "accountFolderSegment".to_string(),
    serde_json::Value::String(account_folder_segment(active_account.as_ref())),
  );
  response.insert(
    "accountLabel".to_string(),
    serde_json::Value::String(account_label(active_account.as_ref())),
  );
  response.insert(
    "effectiveCoreUrl".to_string(),
    effective_daemon_core_url(&preferences)
      .map(serde_json::Value::String)
      .unwrap_or(serde_json::Value::Null),
  );
  Ok(serde_json::Value::Object(response))
}

fn read_daemon_preferences_from_disk(app: &tauri::AppHandle) -> Result<serde_json::Value, String> {
  let path = daemon_preferences_path(app)?;
  if !path.is_file() {
    return Ok(normalize_daemon_preferences(serde_json::json!({})));
  }

  let raw = fs::read_to_string(&path).map_err(|error| {
    format!(
      "failed to read daemon preferences {}: {error}",
      path.display()
    )
  })?;
  let parsed = serde_json::from_str::<serde_json::Value>(&raw).map_err(|error| {
    format!(
      "failed to parse daemon preferences {}: {error}",
      path.display()
    )
  })?;
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
  fs::create_dir_all(parent).map_err(|error| {
    format!(
      "failed to create daemon preferences directory {}: {error}",
      parent.display()
    )
  })?;
  let serialized = serde_json::to_string_pretty(preferences)
    .map_err(|error| format!("failed to serialize daemon preferences: {error}"))?;
  fs::write(&path, format!("{serialized}\n")).map_err(|error| {
    format!(
      "failed to write daemon preferences {}: {error}",
      path.display()
    )
  })
}

fn set_daemon_preference_path(
  app: &tauri::AppHandle,
  key: &str,
  path: Option<PathBuf>,
) -> Result<serde_json::Value, String> {
  let mut preferences = read_daemon_preferences_from_disk(app)?;
  let object = preferences
    .as_object_mut()
    .ok_or_else(|| "daemon preferences were not an object".to_string())?;
  match path {
    Some(path) => {
      object.insert(
        key.to_string(),
        serde_json::Value::String(path_to_string(path)),
      );
    }
    None => {
      object.insert(key.to_string(), serde_json::Value::Null);
    }
  }
  let preferences = normalize_daemon_preferences(preferences);
  write_daemon_preferences_to_disk(app, &preferences)?;
  daemon_preferences_response(app, preferences)
}

fn reset_daemon_preference_paths(
  app: &tauri::AppHandle,
  keys: &[&str],
) -> Result<serde_json::Value, String> {
  let mut preferences = read_daemon_preferences_from_disk(app)?;
  let object = preferences
    .as_object_mut()
    .ok_or_else(|| "daemon preferences were not an object".to_string())?;
  for key in keys {
    object.insert((*key).to_string(), serde_json::Value::Null);
  }
  let preferences = normalize_daemon_preferences(preferences);
  write_daemon_preferences_to_disk(app, &preferences)?;
  daemon_preferences_response(app, preferences)
}

/// Starts the sync daemon when needed.
///
/// Returns `true` when this process spawned it, or `false` when it was already
/// running in this process or another one.
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

  let _guard = daemon_guard::acquire();
  if daemon_is_running_externally() {
    return Ok(false);
  }

  let child = spawn_daemon(app)?;
  *managed = Some(ManagedDaemon { child });
  drop(managed);

  if !wait_for_daemon_readiness() {
    eprintln!(
      "[workbench-native] sync daemon did not become observable within {} seconds",
      DAEMON_READINESS_TIMEOUT.as_secs()
    );
  }
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

  let app = app.clone();
  let _ = std::thread::spawn(move || {
    if let Err(error) = start_daemon_with_app(Some(&app)) {
      eprintln!("[workbench-native] failed to auto-start sync daemon: {error}");
    }
  });
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
pub fn secure_local_daemon_client_save(
  local_client_id: String,
  local_client_token: String,
) -> Result<(), String> {
  secure_storage::save_local_daemon_client_identity(&local_client_id, &local_client_token)
}

#[tauri::command]
pub fn secure_local_daemon_client_status() -> Result<serde_json::Value, String> {
  let identity = secure_storage::read_local_daemon_client_identity()?;
  Ok(match identity {
    Some(identity) => serde_json::json!({
      "supported": secure_storage::is_supported(),
      "available": true,
      "localClientId": identity.local_client_id,
      "hasLocalClientToken": true
    }),
    None => serde_json::json!({
      "supported": secure_storage::is_supported(),
      "available": false,
      "localClientId": null,
      "hasLocalClientToken": false
    }),
  })
}

#[tauri::command]
pub fn secure_local_daemon_client_clear() -> Result<(), String> {
  secure_storage::clear_local_daemon_client_identity()
}

#[tauri::command]
pub fn open_main_window(app: tauri::AppHandle) -> Result<(), String> {
  window::open_new_main_window(&app)
}

#[tauri::command]
pub fn open_quick_note_window(app: tauri::AppHandle) -> Result<(), String> {
  window::open_new_quick_note_window(&app)
}

#[tauri::command]
pub fn open_calendar_window(app: tauri::AppHandle, url: String) -> Result<(), String> {
  window::open_calendar_window(&app, &url)
}

#[tauri::command]
pub fn open_app_window(
  app: tauri::AppHandle,
  current_window: tauri::WebviewWindow,
  url: String,
) -> Result<(), String> {
  window::open_new_app_window(&app, &current_window, &url)
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
    Some(folder_path) => {
      let path = folder_path
        .into_path()
        .map_err(|error| format!("invalid folder path: {error}"))?;
      let selected = path_to_string(path.clone());
      set_daemon_preference_path(&app, "syncRootBase", Some(path))?;
      Ok(Some(selected))
    }
    None => Ok(None),
  }
}

#[tauri::command]
pub async fn choose_downloads_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
  let path = app.dialog().file().blocking_pick_folder();

  match path {
    Some(folder_path) => {
      let path = folder_path
        .into_path()
        .map_err(|error| format!("invalid folder path: {error}"))?;
      let selected = path_to_string(path.clone());
      set_daemon_preference_path(&app, "downloadsDirBase", Some(path))?;
      Ok(Some(selected))
    }
    None => Ok(None),
  }
}

#[tauri::command]
pub fn reset_sync_folder(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
  reset_daemon_preference_paths(&app, &["syncRoot", "syncRootBase"])
}

#[tauri::command]
pub fn reset_downloads_folder(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
  reset_daemon_preference_paths(&app, &["downloadsDir", "downloadsDirBase"])
}

#[tauri::command]
pub fn open_sync_folder(app: tauri::AppHandle) -> Result<bool, String> {
  let preferences = read_daemon_preferences_from_disk(&app)?;
  ensure_folder_and_open(configured_sync_folder(&app, &preferences)?)
}

#[tauri::command]
pub fn open_downloads_folder(app: tauri::AppHandle) -> Result<bool, String> {
  let preferences = read_daemon_preferences_from_disk(&app)?;
  ensure_folder_and_open(configured_downloads_folder(&app, &preferences)?)
}

/// Window controls for the dedicated apps, which run undecorated and draw their own
/// title bar. Each acts on the window that invoked it.
#[tauri::command]
pub fn window_minimize(window: tauri::Window) -> Result<(), String> {
  window
    .minimize()
    .map_err(|error| format!("failed to minimize window: {error}"))
}

#[tauri::command]
pub fn window_toggle_maximize(window: tauri::Window) -> Result<(), String> {
  let maximized = window
    .is_maximized()
    .map_err(|error| format!("failed to read window state: {error}"))?;
  if maximized {
    window
      .unmaximize()
      .map_err(|error| format!("failed to restore window: {error}"))
  } else {
    window
      .maximize()
      .map_err(|error| format!("failed to maximize window: {error}"))
  }
}

#[tauri::command]
pub fn window_is_maximized(window: tauri::Window) -> Result<bool, String> {
  window
    .is_maximized()
    .map_err(|error| format!("failed to read window state: {error}"))
}

#[tauri::command]
pub fn window_close(window: tauri::Window) -> Result<(), String> {
  window
    .close()
    .map_err(|error| format!("failed to close window: {error}"))
}

#[tauri::command]
pub fn window_start_drag(window: tauri::Window) -> Result<(), String> {
  window
    .start_dragging()
    .map_err(|error| format!("failed to start window drag: {error}"))
}

/// Opens the captured daemon output in the OS text editor.
///
/// The daemon runs without a console window, so this is how its console state is reviewed.
#[tauri::command]
pub fn open_daemon_log(app: tauri::AppHandle) -> Result<bool, String> {
  let path = daemon_log_path(&app)?;
  if !path.is_file() {
    return Err(format!(
      "no sync daemon log yet at {} — start the daemon first",
      path.display()
    ));
  }
  open_with_default_app(&path)?;
  Ok(true)
}

#[tauri::command]
pub fn read_daemon_status(port: Option<u16>) -> Result<serde_json::Value, String> {
  let mut status = read_loopback_status(configured_daemon_port(port)?)?;
  if let Some(object) = status.as_object_mut() {
    let native_owned = {
      let mut managed = managed_daemon()
        .lock()
        .map_err(|_| "sync daemon process lock was poisoned".to_string())?;
      match managed.as_mut() {
        Some(daemon) => match daemon.child.try_wait() {
          Ok(None) => true,
          Ok(Some(_status)) => {
            *managed = None;
            false
          }
          Err(error) => {
            eprintln!("[workbench-native] failed to inspect sync daemon process: {error}");
            false
          }
        },
        None => false,
      }
    };
    object.insert(
      "nativeOwned".to_string(),
      serde_json::Value::Bool(native_owned),
    );
  }
  Ok(status)
}

#[tauri::command]
pub fn read_daemon_preferences(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
  let preferences = read_daemon_preferences_from_disk(&app)?;
  daemon_preferences_response(&app, preferences)
}

#[tauri::command]
pub fn set_daemon_auto_start(
  app: tauri::AppHandle,
  auto_start: bool,
) -> Result<serde_json::Value, String> {
  let mut preferences = read_daemon_preferences_from_disk(&app)?;
  let object = preferences
    .as_object_mut()
    .ok_or_else(|| "daemon preferences were not an object".to_string())?;
  object.insert("autoStart".to_string(), serde_json::Value::Bool(auto_start));
  let preferences = normalize_daemon_preferences(preferences);
  write_daemon_preferences_to_disk(&app, &preferences)?;
  daemon_preferences_response(&app, preferences)
}

#[tauri::command]
pub fn set_daemon_resident_mode(
  app: tauri::AppHandle,
  resident_mode: bool,
) -> Result<serde_json::Value, String> {
  let mut preferences = read_daemon_preferences_from_disk(&app)?;
  let object = preferences
    .as_object_mut()
    .ok_or_else(|| "daemon preferences were not an object".to_string())?;
  object.insert(
    "residentMode".to_string(),
    serde_json::Value::Bool(resident_mode),
  );
  let preferences = normalize_daemon_preferences(preferences);
  write_daemon_preferences_to_disk(&app, &preferences)?;
  daemon_preferences_response(&app, preferences)
}

#[tauri::command]
pub fn set_daemon_core_url(
  app: tauri::AppHandle,
  core_url: String,
) -> Result<serde_json::Value, String> {
  let normalized = normalize_daemon_core_url(&core_url)?;
  let mut preferences = read_daemon_preferences_from_disk(&app)?;
  let previous = configured_daemon_core_url(&preferences);
  let changed = previous.as_deref() != Some(normalized.as_str());
  let object = preferences
    .as_object_mut()
    .ok_or_else(|| "daemon preferences were not an object".to_string())?;
  object.insert(
    "coreUrl".to_string(),
    serde_json::Value::String(normalized),
  );
  let preferences = normalize_daemon_preferences(preferences);
  write_daemon_preferences_to_disk(&app, &preferences)?;

  if changed && stop_daemon()? {
    start_daemon_with_app(Some(&app))?;
  }

  daemon_preferences_response(&app, preferences)
}

pub fn daemon_resident_mode_enabled(app: &tauri::AppHandle) -> bool {
  read_daemon_preferences_from_disk(app)
    .ok()
    .and_then(|preferences| {
      preferences
        .get("residentMode")
        .and_then(serde_json::Value::as_bool)
    })
    .unwrap_or(true)
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

#[cfg(test)]
mod tests {
  use super::*;
  use std::{cell::Cell, net::TcpListener};

  fn unique_test_root(name: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .expect("system time should be after unix epoch")
      .as_nanos();
    std::env::temp_dir().join(format!(
      "workbench-native-{name}-{}-{nanos}",
      std::process::id()
    ))
  }

  #[test]
  fn reads_legacy_local_daemon_identity_file() {
    let root = unique_test_root("identity");
    let metadata_dir = root.join(".workbench");
    fs::create_dir_all(&metadata_dir).expect("metadata dir should be created");
    fs::write(
      local_daemon_identity_file(&root),
      r#"{"localClientId":"client-1","localClientToken":"token-1"}"#,
    )
    .expect("identity file should be written");

    let identity = read_local_daemon_identity_file(&root)
      .expect("identity file should be readable")
      .expect("identity should exist");

    assert_eq!(identity.local_client_id, "client-1");
    assert_eq!(identity.local_client_token, "token-1");
    fs::remove_dir_all(root).ok();
  }

  #[test]
  fn returns_none_when_legacy_local_daemon_identity_file_is_missing() {
    let root = unique_test_root("identity-missing");
    fs::create_dir_all(root.join(".workbench")).expect("metadata dir should be created");

    let identity =
      read_local_daemon_identity_file(&root).expect("missing identity file should not be an error");

    assert!(identity.is_none());
    fs::remove_dir_all(root).ok();
  }

  #[test]
  fn builds_account_scoped_folder_segments() {
    let account = ActiveWorkbenchAccount {
      user_id: "user-1234567890abcdef".to_string(),
      username: "Hayato Nakanishi".to_string(),
      access_token: None,
    };

    assert_eq!(
      account_folder_segment(Some(&account)),
      "Hayato-Nakanishi-user-1234567"
    );
    assert_eq!(
      account_sync_root_id(Some(&account)),
      "account-user-1234567890abcdef"
    );
    assert_eq!(account_folder_segment(None), "guest");
  }

  #[test]
  fn normalizes_daemon_core_url() {
    assert_eq!(
      normalize_daemon_core_url(" https://example.com/core/// ").unwrap(),
      "https://example.com/core"
    );
    assert_eq!(
      normalize_daemon_core_url(" http://localhost:3000/// ").unwrap(),
      "http://localhost:3000"
    );
    assert!(normalize_daemon_core_url("ftp://example.com").is_err());
    assert!(normalize_daemon_core_url("http://example.com").is_err());
    assert!(normalize_daemon_core_url("https://exa mple.com").is_err());
  }

  #[test]
  fn stores_core_url_in_normalized_daemon_preferences() {
    let preferences = normalize_daemon_preferences(serde_json::json!({
      "coreUrl": "http://localhost:3000/",
      "autoStart": true
    }));

    assert_eq!(
      preferences.get("coreUrl").and_then(serde_json::Value::as_str),
      Some("http://localhost:3000")
    );
    assert_eq!(
      configured_daemon_core_url(&preferences).as_deref(),
      Some("http://localhost:3000")
    );
  }

  #[test]
  fn parses_active_workbench_account_from_session_json() {
    let account = parse_active_workbench_account(
      r#"{"user":{"id":"core-user-1","username":"alice"},"accessToken":"access-1"}"#,
    )
    .expect("account should parse");

    assert_eq!(account.user_id, "core-user-1");
    assert_eq!(account.username, "alice");
    assert_eq!(account.access_token.as_deref(), Some("access-1"));
  }

  #[test]
  fn detects_loopback_daemon_status() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("test status listener should bind");
    let port = listener
      .local_addr()
      .expect("test status listener should have an address")
      .port();
    let server = std::thread::spawn(move || {
      let (mut stream, _) = listener.accept().expect("status request should connect");
      let mut request = [0_u8; 1024];
      stream
        .read(&mut request)
        .expect("status request should be readable");
      let body = r#"{"status":"ok"}"#;
      write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
      )
      .expect("status response should be written");
    });

    assert_eq!(
      read_loopback_status(port).expect("running status listener should be detected"),
      serde_json::json!({ "status": "ok" })
    );
    server.join().expect("status server should not panic");

    let unused_listener =
      TcpListener::bind(("127.0.0.1", 0)).expect("unused port listener should bind");
    let unused_port = unused_listener
      .local_addr()
      .expect("unused port listener should have an address")
      .port();
    drop(unused_listener);
    assert!(read_loopback_status(unused_port).is_err());
  }

  #[test]
  fn readiness_wait_retries_until_daemon_is_observable() {
    let started = Instant::now();
    let elapsed = Cell::new(Duration::ZERO);
    let attempts = Cell::new(0);
    let sleeps = Cell::new(0);

    let ready = wait_for_daemon_readiness_with(
      Duration::from_millis(4),
      Duration::from_millis(20),
      || {
        let next = attempts.get() + 1;
        attempts.set(next);
        next == 3
      },
      |duration| {
        sleeps.set(sleeps.get() + 1);
        elapsed.set(elapsed.get() + duration);
      },
      || started + elapsed.get(),
    );

    assert!(ready);
    assert_eq!(attempts.get(), 3);
    assert_eq!(sleeps.get(), 2);
    assert_eq!(elapsed.get(), Duration::from_millis(8));
  }

  #[test]
  fn readiness_wait_stops_at_timeout() {
    let started = Instant::now();
    let elapsed = Cell::new(Duration::ZERO);
    let attempts = Cell::new(0);

    let ready = wait_for_daemon_readiness_with(
      Duration::from_millis(4),
      Duration::from_millis(10),
      || {
        attempts.set(attempts.get() + 1);
        false
      },
      |duration| elapsed.set(elapsed.get() + duration),
      || started + elapsed.get(),
    );

    assert!(!ready);
    assert_eq!(attempts.get(), 3);
    assert_eq!(elapsed.get(), Duration::from_millis(10));
  }
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
      std::fs::write(&path_buf, &bytes).map_err(|e| format!("failed to write file: {e}"))?;
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
