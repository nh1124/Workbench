//! Handing the UI's global-shortcut preferences to the resident.
//!
//! The app used to register these itself. It no longer can: the resident owns the tray and
//! the global shortcuts, and two processes cannot hold the same accelerator — whichever
//! registered second would simply fail, and which one that was would depend on startup
//! order.
//!
//! So this command persists rather than registers. The UI is unchanged: it still owns the
//! preferences and still calls one command on whichever window the user has open.

use serde::Deserialize;
use workbench_shared::shortcuts::{GlobalShortcut, write_to_disk};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalShortcutRegistration {
  action_id: String,
  accelerator: String,
}

fn validate(registrations: Vec<GlobalShortcutRegistration>) -> Result<Vec<GlobalShortcut>, String> {
  let mut shortcuts = Vec::with_capacity(registrations.len());
  for registration in registrations {
    let accelerator = registration.accelerator.trim();
    if accelerator.is_empty() {
      return Err("shortcut accelerator cannot be empty".to_string());
    }
    let action_id = registration.action_id.trim();
    if action_id.is_empty() {
      return Err("shortcut action id cannot be empty".to_string());
    }
    shortcuts.push(GlobalShortcut {
      action_id: action_id.to_string(),
      accelerator: accelerator.to_string(),
    });
  }

  // Rejected here rather than in the resident, because here there is a caller to tell. The
  // resident would have to choose one silently.
  let mut seen = std::collections::HashSet::new();
  for shortcut in &shortcuts {
    if !seen.insert(shortcut.accelerator.to_ascii_lowercase()) {
      return Err("duplicate global shortcut registration".to_string());
    }
  }

  Ok(shortcuts)
}

/// Replaces the stored set of desktop-global shortcuts.
///
/// The resident picks the change up on its own; nothing here waits for it. A resident that
/// is not running will read the file when it next starts, which is the same guarantee the
/// stored preferences have always had.
#[tauri::command]
pub fn set_global_shortcuts(
  app: tauri::AppHandle,
  shortcuts: Vec<GlobalShortcutRegistration>,
) -> Result<(), String> {
  let validated = validate(shortcuts)?;
  write_to_disk(&validated)?;
  crate::applog::write(
    &app,
    "shortcuts",
    &format!("stored {} global shortcuts for the resident", validated.len()),
  );
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn registration(action_id: &str, accelerator: &str) -> GlobalShortcutRegistration {
    GlobalShortcutRegistration {
      action_id: action_id.to_string(),
      accelerator: accelerator.to_string(),
    }
  }

  #[test]
  fn validation_trims_and_keeps_order() {
    let validated = validate(vec![
      registration(" new_window ", " Ctrl+Shift+KeyN "),
      registration("quick_note", "Ctrl+Alt+KeyN"),
    ])
    .expect("well-formed registrations should validate");
    assert_eq!(validated[0].action_id, "new_window");
    assert_eq!(validated[0].accelerator, "Ctrl+Shift+KeyN");
    assert_eq!(validated[1].action_id, "quick_note");
  }

  #[test]
  fn an_empty_half_is_rejected() {
    assert!(validate(vec![registration("new_window", "   ")]).is_err());
    assert!(validate(vec![registration("  ", "Ctrl+KeyN")]).is_err());
  }

  #[test]
  fn the_same_accelerator_twice_is_rejected() {
    // Two actions on one accelerator is not a preference the resident could honour: only one
    // of them would ever fire, and which one would be an accident of ordering.
    assert!(validate(vec![
      registration("new_window", "Ctrl+KeyN"),
      registration("quick_note", "ctrl+keyn"),
    ])
    .is_err());
  }
}
