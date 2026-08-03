//! Starting, reaching and stopping the one sync daemon on this machine.
//!
//! The resident owns the daemon's normal lifetime: it starts it at login and leaves it
//! running. The apps keep the same ability because the resident is not guaranteed to be
//! there — a fresh install before the first sign-out, or a user who turned start-at-login
//! off. Whoever gets there first wins; [`launch_guard`](crate::launch_guard) serialises the
//! check-and-spawn so two of them cannot both decide the port is free.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::account::{
  account_label, account_sync_root_id, active_workbench_account, ActiveWorkbenchAccount,
};
use crate::launch_guard;
use crate::loopback;
use crate::paths::{self, path_to_string};
use crate::preferences;
use crate::secure_storage;

const DAEMON_READINESS_POLL_INTERVAL: Duration = Duration::from_millis(250);
const DAEMON_READINESS_TIMEOUT: Duration = Duration::from_secs(20);
const DAEMON_LOG_FILE: &str = "sync-daemon.log";
/// Must match `DAEMON_TOKEN_FILE` in `native/sync-daemon/src/config.ts`; the daemon owns
/// this file and we only read it.
const DAEMON_TOKEN_FILE: &str = "daemon-token";
/// `CREATE_NO_WINDOW` — keeps the console sidecar from flashing up a console window.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const DEFAULT_DAEMON_SIDECAR_NAME: &str = "workbench-sync-daemon";
const LOCAL_CLIENT_ID_ENV: &str = "WORKBENCH_LOCAL_CLIENT_ID";
const LOCAL_CLIENT_TOKEN_ENV: &str = "WORKBENCH_LOCAL_CLIENT_TOKEN";
const PERSIST_CLIENT_IDENTITY_ENV: &str = "WORKBENCH_PERSIST_CLIENT_IDENTITY";
const SECURE_CLIENT_IDENTITY_ENV: &str = "WORKBENCH_SECURE_CLIENT_IDENTITY";
/// Must match the env var read in `native/sync-daemon/src/config.ts`.
const EXIT_WHEN_IDLE_ENV: &str = "WORKBENCH_DAEMON_EXIT_WHEN_IDLE";

struct ManagedDaemon {
  child: Child,
}

struct DaemonCommand {
  program: String,
  args: Vec<String>,
  cwd: PathBuf,
}

fn managed_daemon() -> &'static Mutex<Option<ManagedDaemon>> {
  static MANAGED_DAEMON: OnceLock<Mutex<Option<ManagedDaemon>>> = OnceLock::new();
  MANAGED_DAEMON.get_or_init(|| Mutex::new(None))
}

/// Where the daemon's console output is captured, so it can be reviewed without a console
/// window ever appearing.
pub fn log_path() -> Result<PathBuf, String> {
  paths::shared_config_directory().map(|path| path.join(DAEMON_LOG_FILE))
}

/// The token the daemon writes under the sync root, used to authenticate loopback calls.
pub fn read_api_token(preferences: &serde_json::Value) -> Result<Option<String>, String> {
  let sync_root = preferences::configured_sync_folder(preferences)?;
  let path = sync_root.join(".workbench").join(DAEMON_TOKEN_FILE);
  if !path.is_file() {
    return Ok(None);
  }
  let raw = fs::read_to_string(&path)
    .map_err(|error| format!("failed to read the sync daemon token {}: {error}", path.display()))?;
  let trimmed = raw.trim();
  if trimmed.is_empty() {
    return Ok(None);
  }
  Ok(Some(trimmed.to_string()))
}

/// Calls the daemon's loopback API with this machine's token, failing on any non-2xx.
pub fn api_request(method: &str, path: &str, body: Option<&str>) -> Result<String, String> {
  let port = loopback::configured_daemon_port(None)?;
  let preferences = preferences::read_from_disk()?;
  let token = read_api_token(&preferences)?;
  let (status_code, response) =
    loopback::request_with(port, method, path, token.as_deref(), body)?;
  if !status_code.starts_with('2') {
    return Err(format!(
      "sync daemon rejected {method} {path} with HTTP {status_code}: {}",
      response.trim()
    ));
  }
  Ok(response)
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
    .join("native")
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

/// Directories the packaged sidecar might sit in.
///
/// `extra_roots` is how a Tauri app contributes its resource directory, which the resident
/// has no equivalent of — the resident is installed beside the sidecar, so its own
/// executable's directory is already the answer.
fn sidecar_search_roots(extra_roots: &[PathBuf]) -> Vec<PathBuf> {
  let mut roots = extra_roots.to_vec();
  if let Some(exe_parent) = current_exe_parent() {
    roots.push(exe_parent);
  }
  if let Ok(current_dir) = std::env::current_dir() {
    roots.push(current_dir);
  }
  roots
}

fn find_packaged_sidecar(extra_roots: &[PathBuf]) -> Option<PathBuf> {
  let base_name = std::env::var("WORKBENCH_DAEMON_SIDECAR_NAME")
    .ok()
    .filter(|value| !value.trim().is_empty())
    .unwrap_or_else(|| DEFAULT_DAEMON_SIDECAR_NAME.to_string());
  let names = daemon_executable_names(&base_name);

  for root in sidecar_search_roots(extra_roots) {
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

fn resolve_packaged_sidecar(extra_roots: &[PathBuf]) -> Option<DaemonCommand> {
  let path = find_packaged_sidecar(extra_roots)?;
  Some(DaemonCommand {
    program: path_to_string(path.clone()),
    args: daemon_args_from_env("WORKBENCH_DAEMON_SIDECAR_ARGS"),
    cwd: command_cwd_from_program(&path),
  })
}

fn resolve_daemon_command(extra_roots: &[PathBuf]) -> Result<DaemonCommand, String> {
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

  if let Some(command) = resolve_packaged_sidecar(extra_roots) {
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
      // The package name, not the path: it survives the daemon moving around the repo.
      "sync-daemon".to_string(),
    ],
    cwd,
  })
}

fn configure_daemon_env(command: &mut Command) -> Result<(), String> {
  let active_account = active_workbench_account();
  if std::env::var_os("WORKBENCH_DAEMON_HTTP_PORT").is_none() {
    command.env(
      "WORKBENCH_DAEMON_HTTP_PORT",
      loopback::DEFAULT_DAEMON_HTTP_PORT.to_string(),
    );
  }

  let stored = preferences::read_from_disk()?;
  let configured_core_url = preferences::configured_core_url(&stored);
  let configured_exit_when_idle = preferences::exit_when_idle(&stored);
  let sync_root = preferences::configured_sync_folder(&stored)?;
  let downloads_dir = preferences::configured_downloads_folder(&stored)?;
  command.env("WORKBENCH_SYNC_ROOT", path_to_string(sync_root.clone()));
  command.env("WORKBENCH_DOWNLOADS_DIR", path_to_string(downloads_dir));

  if std::env::var_os(preferences::CORE_URL_ENV).is_none() {
    if let Some(core_url) = configured_core_url {
      command.env(preferences::CORE_URL_ENV, core_url);
    }
  }

  // Whether the daemon outlives the apps is a per-machine setting, and it is read at
  // startup, so changing it only takes effect the next time the daemon starts.
  if std::env::var_os(EXIT_WHEN_IDLE_ENV).is_none() {
    command.env(
      EXIT_WHEN_IDLE_ENV,
      if configured_exit_when_idle { "1" } else { "0" },
    );
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
      format!("Workbench Sync ({})", account_label(active_account.as_ref())),
    );
  }
  if std::env::var_os(SECURE_CLIENT_IDENTITY_ENV).is_none() {
    command.env(SECURE_CLIENT_IDENTITY_ENV, "auto");
  }

  configure_daemon_client_identity_env(command, Some(sync_root.as_path()), active_account.as_ref());
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
    crate::log::write(
      "daemon",
      "not injecting secure local daemon client credentials because parent env is incomplete",
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
          crate::log::write(
            "daemon",
            &format!(
              "failed to migrate local daemon client credentials; daemon will use file fallback: {error}"
            ),
          );
        }
      }
    }
    Err(error) => {
      crate::log::write(
        "daemon",
        &format!(
          "failed to read secure local daemon client credentials; daemon will use file fallback: {error}"
        ),
      );
    }
  }
}

pub fn local_daemon_identity_file(sync_root: &Path) -> PathBuf {
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
      crate::log::write(
        "daemon",
        &format!(
          "migrated local daemon client credentials to secure storage, but failed to remove {}: {error}",
          path.display()
        ),
      );
    }
  }

  Ok(Some(identity))
}

/// Redirects the daemon's stdout/stderr into the log file, truncating what was there.
///
/// Returns `None` when the log cannot be opened; the caller then falls back to discarding
/// output rather than letting it reach a console.
fn daemon_log_sinks() -> Option<(Stdio, Stdio)> {
  let path = log_path().ok()?;
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).ok()?;
  }

  let file = fs::File::create(&path)
    .map_err(|error| {
      crate::log::write(
        "daemon",
        &format!("failed to open sync daemon log {}: {error}", path.display()),
      );
    })
    .ok()?;
  let stderr = file
    .try_clone()
    .map_err(|error| {
      crate::log::write(
        "daemon",
        &format!("failed to duplicate sync daemon log handle: {error}"),
      );
    })
    .ok()?;
  Some((Stdio::from(file), Stdio::from(stderr)))
}

fn spawn_daemon(extra_roots: &[PathBuf]) -> Result<Child, String> {
  let daemon_command = resolve_daemon_command(extra_roots)?;
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

  match daemon_log_sinks() {
    Some((stdout, stderr)) => {
      command.stdout(stdout).stderr(stderr);
    }
    None => {
      command.stdout(Stdio::null()).stderr(Stdio::null());
    }
  }

  configure_daemon_env(&mut command)?;

  command.spawn().map_err(|error| {
    format!(
      "failed to start sync daemon with `{}` from {}: {error}",
      daemon_command.program,
      daemon_command.cwd.display()
    )
  })
}

fn is_running_externally() -> bool {
  let Ok(port) = loopback::configured_daemon_port(None) else {
    return false;
  };
  loopback::is_occupied(port)
}

pub fn wait_for_readiness_with<P, S, N>(
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

fn wait_for_readiness() -> bool {
  wait_for_readiness_with(
    DAEMON_READINESS_POLL_INTERVAL,
    DAEMON_READINESS_TIMEOUT,
    is_running_externally,
    std::thread::sleep,
    Instant::now,
  )
}

/// Waits for the daemon's port to come free after asking it to stop.
///
/// A restart that spawns before the old process has released the port produces the
/// EADDRINUSE crash the launch guard exists to avoid, so the caller has to see it gone.
fn wait_for_stop(port: u16) -> bool {
  let deadline = Instant::now() + DAEMON_READINESS_TIMEOUT;
  while Instant::now() < deadline {
    if !loopback::is_occupied(port) {
      return true;
    }
    std::thread::sleep(DAEMON_READINESS_POLL_INTERVAL);
  }
  false
}

/// Starts the sync daemon when needed.
///
/// Returns `true` when this process spawned it, or `false` when it was already running in
/// this process or another one.
pub fn start(extra_roots: &[PathBuf]) -> Result<bool, String> {
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

  let guard = launch_guard::acquire();
  if is_running_externally() {
    return Ok(false);
  }
  if guard.is_none() {
    // Spawning without the guard is how two daemons end up racing for the port. Whoever
    // holds it is already starting one, so stand down and let the probe find it next time
    // rather than starting a second that will die on EADDRINUSE.
    return Err(
      "another Workbench process is already starting the sync daemon; try again in a moment"
        .to_string(),
    );
  }

  let child = spawn_daemon(extra_roots)?;
  *managed = Some(ManagedDaemon { child });
  drop(managed);

  if !wait_for_readiness() {
    crate::log::write(
      "daemon",
      &format!(
        "sync daemon did not become observable within {} seconds",
        DAEMON_READINESS_TIMEOUT.as_secs()
      ),
    );
  }
  Ok(true)
}

/// Whether the daemon currently running was spawned by this process.
///
/// Surfaced in the status the settings page reads, where it explains why "Stop" behaves the
/// way it does. Reaping a child that has already exited on the way past keeps a dead handle
/// from reading as ownership.
pub fn is_owned_here() -> bool {
  let Ok(mut managed) = managed_daemon().lock() else {
    return false;
  };
  match managed.as_mut() {
    Some(daemon) => match daemon.child.try_wait() {
      Ok(None) => true,
      Ok(Some(_status)) => {
        *managed = None;
        false
      }
      Err(error) => {
        crate::log::write(
          "daemon",
          &format!("failed to inspect sync daemon process: {error}"),
        );
        false
      }
    },
    None => false,
  }
}

/// Stops the daemon, whether or not this process is the one that started it.
///
/// Asking it to stop over its own API is what makes this work from anywhere: killing a child
/// only ever worked for the process holding the handle, so "Stop" did nothing in every other
/// window. Killing stays as the fallback for a daemon that will not answer.
pub fn stop() -> Result<bool, String> {
  let port = loopback::configured_daemon_port(None)?;
  if loopback::is_occupied(port) {
    match api_request("POST", "/shutdown", None) {
      Ok(_) => {
        if wait_for_stop(port) {
          if let Ok(mut managed) = managed_daemon().lock() {
            *managed = None;
          }
          return Ok(true);
        }
        crate::log::write(
          "daemon",
          "sync daemon did not stop in time; falling back to a kill",
        );
      }
      Err(error) => {
        crate::log::write(
          "daemon",
          &format!("sync daemon refused the shutdown request: {error}"),
        );
      }
    }
  }

  stop_owned_process()
}

/// Kills the daemon this process spawned. Does nothing when it merely adopted one.
fn stop_owned_process() -> Result<bool, String> {
  let mut managed = managed_daemon()
    .lock()
    .map_err(|_| "sync daemon process lock was poisoned".to_string())?;

  // Held, not taken: dropping a `Child` does not end the process, so releasing ownership
  // before the kill is confirmed would strand a live daemon that nothing can stop again.
  let Some(daemon) = managed.as_mut() else {
    return Ok(false);
  };

  if daemon
    .child
    .try_wait()
    .map_err(|error| format!("failed to inspect sync daemon process: {error}"))?
    .is_some()
  {
    *managed = None;
    return Ok(true);
  }

  kill_child_process_tree(&mut daemon.child)?;
  daemon
    .child
    .wait()
    .map_err(|error| format!("failed to wait for sync daemon shutdown: {error}"))?;
  *managed = None;
  Ok(true)
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

#[cfg(test)]
mod tests {
  use super::*;
  use std::cell::Cell;

  fn unique_test_root(name: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .expect("system time should be after unix epoch")
      .as_nanos();
    std::env::temp_dir().join(format!(
      "workbench-shared-{name}-{}-{nanos}",
      std::process::id()
    ))
  }

  #[test]
  fn readiness_wait_retries_until_daemon_is_observable() {
    let started = Instant::now();
    let elapsed = Cell::new(Duration::ZERO);
    let attempts = Cell::new(0);
    let sleeps = Cell::new(0);

    let ready = wait_for_readiness_with(
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

    let ready = wait_for_readiness_with(
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
  fn the_sidecar_name_gains_an_exe_suffix_on_windows() {
    let names = daemon_executable_names("workbench-sync-daemon");
    assert_eq!(names[0], "workbench-sync-daemon");
    #[cfg(target_os = "windows")]
    assert_eq!(names[1], "workbench-sync-daemon.exe");
  }

  #[test]
  fn an_empty_sidecar_name_falls_back_to_the_default() {
    assert_eq!(daemon_executable_names("   ")[0], DEFAULT_DAEMON_SIDECAR_NAME);
  }

  #[test]
  fn extra_search_roots_are_tried_before_the_executable_directory() {
    // The app's resource directory has to win: a development build can have a stale sidecar
    // next to the executable while the packaged one sits in resources.
    let extra = PathBuf::from("Z:\\resources");
    let roots = sidecar_search_roots(&[extra.clone()]);
    assert_eq!(roots.first(), Some(&extra));
  }
}
