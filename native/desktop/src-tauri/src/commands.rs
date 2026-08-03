//! Tauri command handlers exposed to the frontend via `invoke`.
//!
//! Anything about the sync daemon — where its files are, which account it syncs as, whether
//! it is already running — lives in `workbench_shared` and is only wrapped here. The
//! resident calls the same code, and one of the two being right about the sync root is not a
//! failure mode worth having.

use std::{
  fs,
  path::PathBuf,
  process::Command,
};

use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

use workbench_shared::{daemon, loopback, paths::path_to_string, preferences, secure_storage};

use crate::window;

/// `CREATE_NO_WINDOW` — keeps helper console processes from flashing up a window.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

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
    use std::os::windows::process::CommandExt;
    Command::new("cmd")
      .arg("/C")
      .arg("start")
      .arg("")
      .arg(path.as_os_str())
      // Without this the helper `cmd` blinks up a console every time a file is opened.
      .creation_flags(CREATE_NO_WINDOW)
      .spawn()
      .map_err(|error| format!("failed to open file with default app: {error}"))?;
    return Ok(());
  }

  #[cfg(target_os = "macos")]
  {
    Command::new("open")
      .arg(path.as_os_str())
      .spawn()
      .map_err(|error| format!("failed to open file with default app: {error}"))?;
    return Ok(());
  }

  #[cfg(all(unix, not(target_os = "macos")))]
  {
    Command::new("xdg-open")
      .arg(path.as_os_str())
      .spawn()
      .map_err(|error| format!("failed to open file with default app: {error}"))?;
    return Ok(());
  }

  #[allow(unreachable_code)]
  Err("opening files is not supported on this platform".to_string())
}

/// Opens a plain-text file the app produced, rather than one the user chose.
///
/// The daemon log must not go through [`open_with_default_app`]: `.log` often has no
/// registered handler on Windows — `assoc .log` reports none on a stock install — and
/// `start` then exits without opening anything. The only thing the user sees is the helper
/// console blinking, which reads as a crash. Notepad is always present and is the right
/// viewer for a log.
pub(crate) fn open_text_file(path: &std::path::Path) -> Result<(), String> {
  #[cfg(target_os = "windows")]
  {
    Command::new("notepad.exe")
      .arg(path.as_os_str())
      .spawn()
      .map_err(|error| format!("failed to open log file: {error}"))?;
    return Ok(());
  }

  #[cfg(not(target_os = "windows"))]
  {
    open_with_default_app(path)
  }
}

fn ensure_folder_and_open(path: PathBuf) -> Result<bool, String> {
  fs::create_dir_all(&path)
    .map_err(|error| format!("failed to create folder {}: {error}", path.display()))?;
  open_with_default_app(&path)?;
  Ok(true)
}

/// Directories this app can offer the shared daemon launcher on top of the ones it finds
/// itself. A packaged Tauri app carries the sidecar in its resource directory.
fn sidecar_search_roots(app: &tauri::AppHandle) -> Vec<PathBuf> {
  app
    .path()
    .resource_dir()
    .ok()
    .into_iter()
    .collect::<Vec<_>>()
}

/// Calls the daemon's lease API. Kept here because `daemon_lease` is the app's own concern.
pub(crate) fn daemon_lease_request(
  _app: &tauri::AppHandle,
  method: &str,
  path: &str,
  body: Option<&str>,
) -> Result<String, String> {
  daemon::api_request(method, path, body)
}

/// Registers this app as depending on the daemon and keeps the lease refreshed.
///
/// Called whether this process started the daemon or found one already running: what the
/// daemon needs to know is who is using it, not who launched it.
///
/// The heartbeat starts even when the first attempt fails, and that is the point — an app
/// that opened before the daemon did would otherwise never hold a lease for the rest of its
/// life, and with `exitWhenIdle` on the daemon would eventually stop under a window that was
/// still in use. Each beat re-registers, so it corrects itself within one interval.
fn hold_daemon_lease(app: &tauri::AppHandle) {
  if let Err(error) = crate::daemon_lease::acquire(app) {
    crate::applog::write(app, "daemon", &format!("could not take a lease yet: {error}"));
  }
  crate::daemon_lease::start_heartbeat(app.clone());
}

/// Starts the daemon if nothing else has, then takes a lease on it either way.
pub fn start_daemon_and_lease(app: &tauri::AppHandle) -> Result<bool, String> {
  let started = daemon::start(&sidecar_search_roots(app))?;
  hold_daemon_lease(app);
  Ok(started)
}

/// Takes a lease on the daemon, starting it first if that is this app's job.
///
/// **The lease is the part that always has to happen.** `exitWhenIdle` means "stop once no
/// window is open", and the daemon works that out from who holds a lease — so an app that
/// skipped this because it was not the one configured to start the daemon would be invisible
/// to it, and the daemon would exit from under a window the user was still using.
///
/// Starting is the conditional half. The resident normally has the daemon up long before any
/// window opens; `autoStart` is the fallback for a machine where the resident is not running
/// at all. The launch guard makes the overlap safe.
pub fn ensure_daemon_for_app(app: &tauri::AppHandle) {
  let app = app.clone();
  let _ = std::thread::spawn(move || {
    let should_start = match preferences::read_from_disk() {
      Ok(preferences) => preferences::auto_start(&preferences),
      Err(error) => {
        crate::applog::write(
          &app,
          "daemon",
          &format!("failed to read daemon preferences: {error}"),
        );
        false
      }
    };

    if should_start {
      if let Err(error) = start_daemon_and_lease(&app) {
        crate::applog::write(&app, "daemon", &format!("failed to auto-start: {error}"));
        // Still take the lease below: the start may have failed because the resident
        // already had one running, which is exactly the case that needs a lease.
      } else {
        return;
      }
    }

    hold_daemon_lease(&app);
  });
}

/// Adds the derived values the settings page shows next to the stored ones.
fn daemon_preferences_response(preferences: serde_json::Value) -> Result<serde_json::Value, String> {
  use workbench_shared::account::{account_folder_segment, account_label, active_workbench_account};

  let effective_sync_root = preferences::configured_sync_folder(&preferences)?;
  let effective_downloads_dir = preferences::configured_downloads_folder(&preferences)?;
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
    preferences::effective_core_url(&preferences)
      .map(serde_json::Value::String)
      .unwrap_or(serde_json::Value::Null),
  );
  Ok(serde_json::Value::Object(response))
}

fn set_daemon_preference_path(key: &str, path: Option<PathBuf>) -> Result<serde_json::Value, String> {
  let mut stored = preferences::read_from_disk()?;
  let object = stored
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
  let stored = preferences::normalize(stored);
  preferences::write_to_disk(&stored)?;
  daemon_preferences_response(stored)
}

fn reset_daemon_preference_paths(keys: &[&str]) -> Result<serde_json::Value, String> {
  let mut stored = preferences::read_from_disk()?;
  let object = stored
    .as_object_mut()
    .ok_or_else(|| "daemon preferences were not an object".to_string())?;
  for key in keys {
    object.insert((*key).to_string(), serde_json::Value::Null);
  }
  let stored = preferences::normalize(stored);
  preferences::write_to_disk(&stored)?;
  daemon_preferences_response(stored)
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
pub async fn open_main_window(app: tauri::AppHandle) -> Result<(), String> {
  window::build_logged(&app, "main window", |app| window::open_new_main_window(app))
}

#[tauri::command]
pub async fn open_quick_note_window(app: tauri::AppHandle) -> Result<(), String> {
  window::build_logged(&app, "quick note window", |app| {
    window::open_new_quick_note_window(app)
  })
}

#[tauri::command]
pub async fn open_calendar_window(app: tauri::AppHandle, url: String) -> Result<(), String> {
  window::build_logged(&app, "calendar window", move |app| {
    window::open_calendar_window(app, &url)
  })
}

#[tauri::command]
pub async fn open_app_window(
  app: tauri::AppHandle,
  current_window: tauri::WebviewWindow,
  url: String,
) -> Result<(), String> {
  window::build_logged(&app, "app window", move |app| {
    window::open_new_app_window(app, &current_window, &url)
  })
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
      set_daemon_preference_path("syncRootBase", Some(path))?;
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
      set_daemon_preference_path("downloadsDirBase", Some(path))?;
      Ok(Some(selected))
    }
    None => Ok(None),
  }
}

#[tauri::command]
pub fn reset_sync_folder() -> Result<serde_json::Value, String> {
  reset_daemon_preference_paths(&["syncRoot", "syncRootBase"])
}

#[tauri::command]
pub fn reset_downloads_folder() -> Result<serde_json::Value, String> {
  reset_daemon_preference_paths(&["downloadsDir", "downloadsDirBase"])
}

#[tauri::command]
pub fn open_sync_folder() -> Result<bool, String> {
  let stored = preferences::read_from_disk()?;
  ensure_folder_and_open(preferences::configured_sync_folder(&stored)?)
}

#[tauri::command]
pub fn open_downloads_folder() -> Result<bool, String> {
  let stored = preferences::read_from_disk()?;
  ensure_folder_and_open(preferences::configured_downloads_folder(&stored)?)
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

/// Opens another dedicated-app window, e.g. one note in its own window.
#[tauri::command]
pub async fn open_variant_window(app: tauri::AppHandle, query: String) -> Result<(), String> {
  window::build_logged(&app, "dedicated app window", move |app| {
    window::open_variant_window(app, &query)
  })
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
pub fn open_daemon_log() -> Result<bool, String> {
  let path = daemon::log_path()?;
  if !path.is_file() {
    return Err(format!(
      "no sync daemon log yet at {} — start the daemon first",
      path.display()
    ));
  }
  open_text_file(&path)?;
  Ok(true)
}

/// Reads the token the sync daemon expects on every local API request.
///
/// The daemon generates this itself and writes it under the sync root, then logs "Paste it
/// into Settings > Local daemon" — a manual step the desktop app has no reason to ask for,
/// since it already knows where the sync root is. Without the token every call from the
/// webview comes back 401, which is why daemon status never loaded and local routing could
/// not be used at all.
///
/// Returns `None` rather than an error when the daemon has not generated one yet; that is
/// the ordinary state before its first run, not a failure.
#[tauri::command]
pub fn read_local_daemon_api_token() -> Result<Option<String>, String> {
  let stored = preferences::read_from_disk()?;
  daemon::read_api_token(&stored)
}

#[tauri::command]
pub fn read_daemon_status(port: Option<u16>) -> Result<serde_json::Value, String> {
  // `/status` is behind the daemon's loopback auth, so this needs the same token the webview
  // sends. Without it every call came back 401.
  let token = read_local_daemon_api_token()?;
  let mut status = loopback::read_status(
    loopback::configured_daemon_port(port)?,
    token.as_deref(),
  )?;
  if let Some(object) = status.as_object_mut() {
    object.insert(
      "nativeOwned".to_string(),
      serde_json::Value::Bool(daemon::is_owned_here()),
    );
  }
  Ok(status)
}

#[tauri::command]
pub fn read_daemon_preferences() -> Result<serde_json::Value, String> {
  daemon_preferences_response(preferences::read_from_disk()?)
}

#[tauri::command]
pub fn set_daemon_auto_start(auto_start: bool) -> Result<serde_json::Value, String> {
  let mut stored = preferences::read_from_disk()?;
  let object = stored
    .as_object_mut()
    .ok_or_else(|| "daemon preferences were not an object".to_string())?;
  object.insert("autoStart".to_string(), serde_json::Value::Bool(auto_start));
  let stored = preferences::normalize(stored);
  preferences::write_to_disk(&stored)?;
  daemon_preferences_response(stored)
}

/// Whether the daemon stops once no app is holding a lease.
///
/// Pushed to the running daemon as well as persisted for its next start. Storing it alone
/// would make this a toggle that appears to do nothing until the daemon happens to restart.
#[tauri::command]
pub fn set_daemon_exit_when_idle(
  app: tauri::AppHandle,
  exit_when_idle: bool,
) -> Result<serde_json::Value, String> {
  let mut stored = preferences::read_from_disk()?;
  let object = stored
    .as_object_mut()
    .ok_or_else(|| "daemon preferences were not an object".to_string())?;
  object.insert(
    "exitWhenIdle".to_string(),
    serde_json::Value::Bool(exit_when_idle),
  );
  let stored = preferences::normalize(stored);
  preferences::write_to_disk(&stored)?;

  if let Ok(port) = loopback::configured_daemon_port(None) {
    if loopback::is_occupied(port) {
      let payload = serde_json::json!({ "exitWhenIdle": exit_when_idle }).to_string();
      if let Err(error) = daemon::api_request("PUT", "/leases/policy", Some(&payload)) {
        // The stored value still applies at the daemon's next start, so this is worth
        // reporting but not worth failing the setting change over.
        crate::applog::write(
          &app,
          "daemon",
          &format!("could not apply the idle policy to the running daemon: {error}"),
        );
      }
    }
  }

  daemon_preferences_response(stored)
}

#[tauri::command]
pub fn set_daemon_core_url(
  app: tauri::AppHandle,
  core_url: String,
) -> Result<serde_json::Value, String> {
  let normalized = preferences::normalize_core_url(&core_url)?;
  let mut stored = preferences::read_from_disk()?;
  let previous = preferences::configured_core_url(&stored);
  let changed = previous.as_deref() != Some(normalized.as_str());
  let object = stored
    .as_object_mut()
    .ok_or_else(|| "daemon preferences were not an object".to_string())?;
  object.insert("coreUrl".to_string(), serde_json::Value::String(normalized));
  let stored = preferences::normalize(stored);
  preferences::write_to_disk(&stored)?;

  if changed && daemon::stop()? {
    start_daemon_and_lease(&app)?;
  }

  daemon_preferences_response(stored)
}

#[tauri::command]
pub fn start_daemon(app: tauri::AppHandle) -> Result<bool, String> {
  start_daemon_and_lease(&app)
}

#[tauri::command]
pub fn stop_daemon() -> Result<bool, String> {
  daemon::stop()
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
      fs::write(&path_buf, &bytes).map_err(|e| format!("failed to write file: {e}"))?;
      Ok(true)
    }
    None => Ok(false), // user cancelled
  }
}

/// Save a temporary file and ask the OS to open it with the default associated app.
#[tauri::command]
pub fn open_file_in_os_app(bytes: Vec<u8>, default_name: String) -> Result<bool, String> {
  let temp_dir = std::env::temp_dir().join("workbench-open");
  fs::create_dir_all(&temp_dir)
    .map_err(|error| format!("failed to create temp directory: {error}"))?;

  let ts = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|value| value.as_millis())
    .unwrap_or(0);

  let file_name = format!("{ts}-{}", sanitize_temp_filename(&default_name));
  let file_path = temp_dir.join(file_name);
  fs::write(&file_path, &bytes).map_err(|error| format!("failed to write temp file: {error}"))?;

  open_with_default_app(&file_path)?;
  Ok(true)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn temp_filenames_lose_the_characters_a_path_cannot_carry() {
    assert_eq!(sanitize_temp_filename("a/b:c*.docx"), "a_b_c_.docx");
  }

  #[test]
  fn a_blank_temp_filename_falls_back_to_a_usable_one() {
    assert_eq!(sanitize_temp_filename("   "), "document.docx");
    // `///` is not blank once replaced, so it stays: the fallback is for names that would
    // otherwise be empty, not for ones that end up ugly.
    assert_eq!(sanitize_temp_filename("///"), "___");
  }

  #[test]
  fn the_preferences_response_carries_the_derived_values_the_settings_page_reads() {
    let response = daemon_preferences_response(preferences::normalize(serde_json::json!({
      "syncRoot": "D:\\Sync",
      "downloadsDir": "D:\\Down"
    })))
    .expect("a fully specified preference set should resolve");

    assert_eq!(
      response.get("effectiveSyncRoot").and_then(serde_json::Value::as_str),
      Some("D:\\Sync")
    );
    assert_eq!(
      response
        .get("effectiveDownloadsDir")
        .and_then(serde_json::Value::as_str),
      Some("D:\\Down")
    );
    for key in ["accountFolderSegment", "accountLabel", "effectiveCoreUrl"] {
      assert!(response.get(key).is_some(), "{key} should be present");
    }
  }
}
