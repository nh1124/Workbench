//! `daemon-preferences.json` — the settings that describe one shared sync daemon.
//!
//! Every app and the resident read and write this same file, which is why it lives in the
//! config directory shared by all of them rather than in any one identifier's folder.
//!
//! Known limitation, carried over: these are read-modify-write whole-file updates with no
//! locking, so two processes changing different settings at the same moment can lose one of
//! them. The resident only reads, which narrows the window but does not close it.

use std::fs;
use std::path::PathBuf;

use crate::account::{account_folder_segment, active_workbench_account};
use crate::paths::{env_path, path_to_string, shared_config_directory};

const DAEMON_PREFERENCES_FILE: &str = "daemon-preferences.json";
/// Must match the env var read in `native/sync-daemon/src/config.ts`.
pub const CORE_URL_ENV: &str = "WORKBENCH_CORE_URL";

pub fn preferences_path() -> Result<PathBuf, String> {
  shared_config_directory().map(|path| path.join(DAEMON_PREFERENCES_FILE))
}

fn normalized_optional_path_string(value: &serde_json::Value, key: &str) -> Option<String> {
  value
    .get(key)
    .and_then(serde_json::Value::as_str)
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(|value| path_to_string(PathBuf::from(value)))
}

pub fn normalize_core_url(raw: &str) -> Result<String, String> {
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
    .and_then(|value| normalize_core_url(value).ok())
}

pub fn normalize(value: serde_json::Value) -> serde_json::Value {
  let auto_start = value
    .get("autoStart")
    .and_then(serde_json::Value::as_bool)
    .unwrap_or(false);
  // Off by default: sync has no reason to stop just because the last window closed.
  let exit_when_idle = value
    .get("exitWhenIdle")
    .and_then(serde_json::Value::as_bool)
    .unwrap_or(false);
  serde_json::json!({
    "autoStart": auto_start,
    "exitWhenIdle": exit_when_idle,
    "syncRoot": normalized_optional_path_string(&value, "syncRoot"),
    "downloadsDir": normalized_optional_path_string(&value, "downloadsDir"),
    "syncRootBase": normalized_optional_path_string(&value, "syncRootBase"),
    "downloadsDirBase": normalized_optional_path_string(&value, "downloadsDirBase"),
    "coreUrl": normalized_optional_url_string(&value, "coreUrl")
  })
}

pub fn read_from_disk() -> Result<serde_json::Value, String> {
  let path = preferences_path()?;
  if !path.is_file() {
    return Ok(normalize(serde_json::json!({})));
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
  Ok(normalize(parsed))
}

pub fn write_to_disk(preferences: &serde_json::Value) -> Result<(), String> {
  let path = preferences_path()?;
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

pub fn configured_path(preferences: &serde_json::Value, key: &str) -> Option<PathBuf> {
  preferences
    .get(key)
    .and_then(serde_json::Value::as_str)
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(PathBuf::from)
}

pub fn default_sync_folder() -> Result<PathBuf, String> {
  if let Some(path) = env_path("WORKBENCH_SYNC_ROOT") {
    return Ok(path);
  }

  let account = active_workbench_account();
  let account_segment = account_folder_segment(account.as_ref());
  crate::paths::home_directory().map(|path| path.join("WorkbenchSync").join(account_segment))
}

pub fn default_downloads_folder() -> Result<PathBuf, String> {
  if let Some(path) = env_path("WORKBENCH_DOWNLOADS_DIR") {
    return Ok(path);
  }

  let account = active_workbench_account();
  let account_segment = account_folder_segment(account.as_ref());
  crate::paths::downloads_directory().map(|path| path.join("Workbench").join(account_segment))
}

pub fn configured_sync_folder(preferences: &serde_json::Value) -> Result<PathBuf, String> {
  if let Some(base) = configured_path(preferences, "syncRootBase") {
    let account = active_workbench_account();
    return Ok(base.join(account_folder_segment(account.as_ref())));
  }

  configured_path(preferences, "syncRoot")
    .map(Ok)
    .unwrap_or_else(default_sync_folder)
}

pub fn configured_downloads_folder(preferences: &serde_json::Value) -> Result<PathBuf, String> {
  if let Some(base) = configured_path(preferences, "downloadsDirBase") {
    let account = active_workbench_account();
    return Ok(base.join(account_folder_segment(account.as_ref())));
  }

  configured_path(preferences, "downloadsDir")
    .map(Ok)
    .unwrap_or_else(default_downloads_folder)
}

pub fn configured_core_url(preferences: &serde_json::Value) -> Option<String> {
  preferences
    .get("coreUrl")
    .and_then(serde_json::Value::as_str)
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(ToString::to_string)
}

pub fn effective_core_url(preferences: &serde_json::Value) -> Option<String> {
  configured_core_url(preferences).or_else(|| {
    std::env::var(CORE_URL_ENV)
      .ok()
      .and_then(|value| normalize_core_url(&value).ok())
  })
}

pub fn exit_when_idle(preferences: &serde_json::Value) -> bool {
  preferences
    .get("exitWhenIdle")
    .and_then(serde_json::Value::as_bool)
    .unwrap_or(false)
}

pub fn auto_start(preferences: &serde_json::Value) -> bool {
  preferences
    .get("autoStart")
    .and_then(serde_json::Value::as_bool)
    .unwrap_or(false)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn normalizing_an_empty_object_produces_every_key() {
    let normalized = normalize(serde_json::json!({}));
    for key in [
      "autoStart",
      "exitWhenIdle",
      "syncRoot",
      "downloadsDir",
      "syncRootBase",
      "downloadsDirBase",
      "coreUrl",
    ] {
      assert!(normalized.get(key).is_some(), "{key} should be present");
    }
    assert_eq!(normalized["autoStart"], serde_json::json!(false));
    assert_eq!(normalized["exitWhenIdle"], serde_json::json!(false));
  }

  #[test]
  fn residentmode_does_not_survive_normalization() {
    // The resident owns residency now, so a value left over from an older install must not
    // be carried forward as if it still meant something.
    let normalized = normalize(serde_json::json!({ "residentMode": true }));
    assert!(normalized.get("residentMode").is_none());
  }

  #[test]
  fn blank_paths_normalize_away() {
    let normalized = normalize(serde_json::json!({ "syncRoot": "   " }));
    assert_eq!(normalized["syncRoot"], serde_json::Value::Null);
  }

  #[test]
  fn core_urls_must_be_https_unless_they_are_loopback() {
    assert_eq!(
      normalize_core_url(" https://example.com/core/// ").unwrap(),
      "https://example.com/core"
    );
    assert_eq!(
      normalize_core_url(" http://localhost:3000/// ").unwrap(),
      "http://localhost:3000"
    );
    assert!(normalize_core_url("http://127.0.0.1:4000").is_ok());
    assert!(normalize_core_url("ftp://example.com").is_err());
    assert!(normalize_core_url("http://example.com").is_err());
    assert!(normalize_core_url("https://exa mple.com").is_err());
    assert!(normalize_core_url("  ").is_err());
  }

  #[test]
  fn stores_core_url_in_normalized_preferences() {
    let normalized = normalize(serde_json::json!({
      "coreUrl": "http://localhost:3000/",
      "autoStart": true
    }));

    assert_eq!(
      normalized.get("coreUrl").and_then(serde_json::Value::as_str),
      Some("http://localhost:3000")
    );
    assert_eq!(
      configured_core_url(&normalized).as_deref(),
      Some("http://localhost:3000")
    );
    assert!(auto_start(&normalized));
  }

  #[test]
  fn a_base_folder_gets_the_account_segment_appended() {
    // With no account in the credential store this is the guest folder, which is the case
    // that matters: a signed-out machine must not write into a signed-in user's tree.
    let folder = configured_sync_folder(&serde_json::json!({ "syncRootBase": "D:\\Base" }))
      .expect("a base path should resolve");
    assert!(folder.starts_with("D:\\Base") || folder.starts_with("D:/Base"));
    assert_ne!(folder, PathBuf::from("D:\\Base"));
  }

  #[test]
  fn an_explicit_sync_root_is_used_verbatim() {
    let folder = configured_sync_folder(&serde_json::json!({ "syncRoot": "D:\\Exact" }))
      .expect("an explicit path should resolve");
    assert_eq!(folder, PathBuf::from("D:\\Exact"));
  }
}
