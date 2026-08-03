//! The desktop-global shortcuts, and how the UI hands them to the resident.
//!
//! The UI still owns the preferences and still calls one command on whichever app the user
//! has open. That app no longer registers anything — the resident does — so the command
//! writes the registrations here instead, and the resident picks them up. A file rather than
//! an IPC channel because the resident has to work from whatever was last configured even if
//! no app has run since it started.

use std::fs;
use std::path::PathBuf;

use crate::paths::shared_config_directory;

const GLOBAL_SHORTCUTS_FILE: &str = "global-shortcuts.json";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GlobalShortcut {
  pub action_id: String,
  pub accelerator: String,
}

pub fn shortcuts_path() -> Result<PathBuf, String> {
  shared_config_directory().map(|path| path.join(GLOBAL_SHORTCUTS_FILE))
}

/// What the resident registers before any app has configured anything.
pub fn defaults() -> Vec<GlobalShortcut> {
  [
    ("new_window", "Ctrl+Shift+KeyN"),
    ("quick_note", "Super+Alt+KeyN"),
    ("quick_note_alt", "Ctrl+Alt+KeyN"),
    ("open_calendar_window", "Ctrl+Alt+KeyC"),
  ]
  .into_iter()
  .map(|(action_id, accelerator)| GlobalShortcut {
    action_id: action_id.to_string(),
    accelerator: accelerator.to_string(),
  })
  .collect()
}

pub fn parse(value: &serde_json::Value) -> Vec<GlobalShortcut> {
  let Some(items) = value.get("shortcuts").and_then(serde_json::Value::as_array) else {
    return Vec::new();
  };
  items
    .iter()
    .filter_map(|item| {
      let action_id = item
        .get("actionId")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
      let accelerator = item
        .get("accelerator")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
      Some(GlobalShortcut {
        action_id: action_id.to_string(),
        accelerator: accelerator.to_string(),
      })
    })
    .collect()
}

pub fn to_json(shortcuts: &[GlobalShortcut]) -> serde_json::Value {
  serde_json::json!({
    "shortcuts": shortcuts
      .iter()
      .map(|shortcut| serde_json::json!({
        "actionId": shortcut.action_id,
        "accelerator": shortcut.accelerator
      }))
      .collect::<Vec<_>>()
  })
}

/// Reads what the UI last configured, falling back to the defaults.
///
/// A malformed or empty file is treated as "nothing configured" rather than "no shortcuts":
/// leaving the user with no global shortcuts at all is a worse answer than the defaults they
/// started with, and it looks identical to the feature being broken.
pub fn read_from_disk() -> Vec<GlobalShortcut> {
  let Ok(path) = shortcuts_path() else {
    return defaults();
  };
  if !path.is_file() {
    return defaults();
  }
  let Ok(raw) = fs::read_to_string(&path) else {
    return defaults();
  };
  let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else {
    crate::log::write(
      "shortcuts",
      &format!("ignoring malformed {} and using defaults", path.display()),
    );
    return defaults();
  };
  let shortcuts = parse(&parsed);
  if shortcuts.is_empty() {
    return defaults();
  }
  shortcuts
}

pub fn write_to_disk(shortcuts: &[GlobalShortcut]) -> Result<(), String> {
  let path = shortcuts_path()?;
  let parent = path
    .parent()
    .ok_or_else(|| format!("global shortcuts path has no parent: {}", path.display()))?;
  fs::create_dir_all(parent).map_err(|error| {
    format!(
      "failed to create the global shortcuts directory {}: {error}",
      parent.display()
    )
  })?;
  let serialized = serde_json::to_string_pretty(&to_json(shortcuts))
    .map_err(|error| format!("failed to serialize global shortcuts: {error}"))?;
  fs::write(&path, format!("{serialized}\n")).map_err(|error| {
    format!(
      "failed to write global shortcuts {}: {error}",
      path.display()
    )
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_defaults_cover_every_action_the_resident_handles() {
    let ids: Vec<_> = defaults()
      .into_iter()
      .map(|shortcut| shortcut.action_id)
      .collect();
    assert_eq!(
      ids,
      vec![
        "new_window",
        "quick_note",
        "quick_note_alt",
        "open_calendar_window"
      ]
    );
  }

  #[test]
  fn parsing_round_trips_through_the_stored_shape() {
    let shortcuts = defaults();
    assert_eq!(parse(&to_json(&shortcuts)), shortcuts);
  }

  #[test]
  fn entries_missing_either_half_are_dropped() {
    let parsed = parse(&serde_json::json!({
      "shortcuts": [
        { "actionId": "quick_note" },
        { "accelerator": "Ctrl+KeyK" },
        { "actionId": "  ", "accelerator": "Ctrl+KeyK" },
        { "actionId": "new_window", "accelerator": "Ctrl+KeyN" }
      ]
    }));
    assert_eq!(
      parsed,
      vec![GlobalShortcut {
        action_id: "new_window".to_string(),
        accelerator: "Ctrl+KeyN".to_string()
      }]
    );
  }

  #[test]
  fn a_payload_without_a_shortcuts_array_parses_to_nothing() {
    assert!(parse(&serde_json::json!({})).is_empty());
  }
}
