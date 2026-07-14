//! Global keyboard shortcut registration.
//!
//! The UI owns shortcut preferences. The native layer keeps only the currently
//! registered desktop-global shortcuts and refreshes them through Tauri IPC.

#[cfg(desktop)]
use std::collections::HashSet;

#[cfg(desktop)]
use serde::Deserialize;
#[cfg(desktop)]
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[cfg(desktop)]
use crate::window;

#[cfg(desktop)]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalShortcutRegistration {
  action_id: String,
  accelerator: String,
}

#[cfg(desktop)]
fn default_global_shortcuts() -> Vec<GlobalShortcutRegistration> {
  vec![
    GlobalShortcutRegistration {
      action_id: "new_window".to_string(),
      accelerator: "Ctrl+Shift+KeyN".to_string(),
    },
    GlobalShortcutRegistration {
      action_id: "quick_note".to_string(),
      accelerator: "Super+Alt+KeyN".to_string(),
    },
    GlobalShortcutRegistration {
      action_id: "quick_note_alt".to_string(),
      accelerator: "Ctrl+Alt+KeyN".to_string(),
    },
    GlobalShortcutRegistration {
      action_id: "open_calendar_window".to_string(),
      accelerator: "Ctrl+Alt+KeyC".to_string(),
    },
  ]
}

#[cfg(desktop)]
fn handle_shortcut_action(app: &tauri::AppHandle, action_id: &str) -> Result<(), String> {
  match action_id {
    "new_window" => window::open_new_main_window(app),
    "quick_note" | "quick_note_alt" => window::open_new_quick_note_window(app),
    "open_calendar_window" => window::open_calendar_window(
      app,
      "/tasks/calendar",
    ),
    _ => Ok(()),
  }
}

#[cfg(desktop)]
fn parse_registration(registration: GlobalShortcutRegistration) -> Result<(String, Shortcut), String> {
  let accelerator = registration.accelerator.trim();
  if accelerator.is_empty() {
    return Err("shortcut accelerator cannot be empty".to_string());
  }
  let shortcut = accelerator
    .parse::<Shortcut>()
    .map_err(|error| format!("invalid shortcut {accelerator}: {error}"))?;
  Ok((registration.action_id, shortcut))
}

/// Replaces all desktop-global shortcuts owned by Workbench.
#[cfg(desktop)]
pub fn set_global_shortcuts_impl(
  app: &tauri::AppHandle,
  registrations: Vec<GlobalShortcutRegistration>,
) -> Result<(), String> {
  let parsed = registrations
    .into_iter()
    .map(parse_registration)
    .collect::<Result<Vec<_>, _>>()?;

  let mut seen_shortcut_ids = HashSet::new();
  for (_, shortcut) in &parsed {
    if !seen_shortcut_ids.insert(shortcut.id()) {
      return Err("duplicate global shortcut registration".to_string());
    }
  }

  app
    .global_shortcut()
    .unregister_all()
    .map_err(|error| format!("failed to unregister global shortcuts: {error}"))?;

  for (action_id, shortcut) in parsed {
    let action_id_for_handler = action_id.clone();
    app
      .global_shortcut()
      .on_shortcut(shortcut, move |app, _shortcut, event| {
        if event.state() != ShortcutState::Pressed {
          return;
        }
        if let Err(error) = handle_shortcut_action(app, &action_id_for_handler) {
          eprintln!("[workbench-native] global shortcut {action_id_for_handler} failed: {error}");
        }
      })
      .map_err(|error| format!("failed to register global shortcut for {action_id}: {error}"))?;
  }

  Ok(())
}

#[cfg(desktop)]
#[tauri::command]
pub fn set_global_shortcuts(
  app: tauri::AppHandle,
  shortcuts: Vec<GlobalShortcutRegistration>,
) -> Result<(), String> {
  set_global_shortcuts_impl(&app, shortcuts)
}

#[cfg(not(desktop))]
#[tauri::command]
pub fn set_global_shortcuts(_shortcuts: Vec<serde_json::Value>) -> Result<(), String> {
  Ok(())
}

/// Installs the global shortcut plugin and registers defaults until the UI
/// sends user preferences.
#[cfg(desktop)]
pub fn register(app: &tauri::App) {
  let plugin_result = app
    .handle()
    .plugin(tauri_plugin_global_shortcut::Builder::new().build());

  if let Err(error) = plugin_result {
    eprintln!("[workbench-native] global shortcut plugin setup failed: {error}");
    return;
  }

  if let Err(error) = set_global_shortcuts_impl(app.handle(), default_global_shortcuts()) {
    eprintln!("[workbench-native] default global shortcut registration failed: {error}");
  }
}
