//! Global keyboard shortcut registration.
//!
//! Registered shortcuts:
//! | Shortcut            | Action                  |
//! |---------------------|-------------------------|
//! | Ctrl+Shift+N        | Open new main window    |
//! | Win+Alt+N           | Open quick-note window  |
//! | Ctrl+Alt+N          | Open quick-note window  |

#[cfg(desktop)]
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::window;

/// Registers all global keyboard shortcuts with the application.
///
/// Should be called once during [`tauri::Builder::setup`].
#[cfg(desktop)]
pub fn register(app: &tauri::App) {
  let ctrl_shift_n = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyN);
  let win_alt_n = Shortcut::new(Some(Modifiers::SUPER | Modifiers::ALT), Code::KeyN);
  let ctrl_alt_n = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyN);

  let ctrl_shift_n_id = ctrl_shift_n.clone();
  let win_alt_n_id = win_alt_n.clone();
  let ctrl_alt_n_id = ctrl_alt_n.clone();

  let plugin_result = app.handle().plugin(
    tauri_plugin_global_shortcut::Builder::new()
      .with_handler(move |app, shortcut, event| {
        if event.state() != ShortcutState::Pressed {
          return;
        }
        if shortcut == &ctrl_shift_n_id {
          if let Err(error) = window::open_new_main_window(app) {
            eprintln!("[workbench-native] Ctrl+Shift+N failed to open main window: {error}");
          }
        } else if shortcut == &win_alt_n_id || shortcut == &ctrl_alt_n_id {
          if let Err(error) = window::open_new_quick_note_window(app) {
            eprintln!("[workbench-native] quick-note shortcut failed to open window: {error}");
          }
        }
      })
      .build(),
  );

  if let Err(error) = plugin_result {
    eprintln!("[workbench-native] global shortcut plugin setup failed: {error}");
    return;
  }

  let entries: &[(&Shortcut, &str)] = &[
    (&ctrl_shift_n, "Ctrl+Shift+N"),
    (&win_alt_n, "Win+Alt+N"),
    (&ctrl_alt_n, "Ctrl+Alt+N"),
  ];

  for (shortcut, name) in entries {
    if let Err(error) = app.global_shortcut().register((*shortcut).clone()) {
      eprintln!("[workbench-native] failed to register hotkey {name}: {error}");
    }
  }
}
