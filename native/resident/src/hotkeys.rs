//! Desktop-global shortcuts, owned by the resident.
//!
//! The apps used to register these. They cannot any more and should not: an accelerator can
//! only be held by one process, so with four apps that could each be open or closed, which
//! one held `Ctrl+Alt+N` depended on startup order. One resident that is always running is
//! the whole point.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use global_hotkey::hotkey::HotKey;
use global_hotkey::{GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState};

use crate::action::{self, Action};

/// Maps a registered hotkey's id to what it should do. The event carries only the id.
fn bindings() -> &'static Mutex<HashMap<u32, Action>> {
  static BINDINGS: OnceLock<Mutex<HashMap<u32, Action>>> = OnceLock::new();
  BINDINGS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub struct Hotkeys {
  manager: GlobalHotKeyManager,
  registered: Vec<HotKey>,
}

impl Hotkeys {
  /// Creates the manager and starts routing events into the action queue.
  ///
  /// Must be called on the message-loop thread: `global-hotkey` requires the manager and the
  /// loop to share a thread on Windows.
  pub fn new() -> Result<Self, String> {
    let manager = GlobalHotKeyManager::new()
      .map_err(|error| format!("failed to create the global hotkey manager: {error}"))?;

    GlobalHotKeyEvent::set_event_handler(Some(|event: GlobalHotKeyEvent| {
      // Both edges arrive; acting on the release would fire everything twice.
      if event.state() != HotKeyState::Pressed {
        return;
      }
      let action = bindings()
        .lock()
        .ok()
        .and_then(|bindings| bindings.get(&event.id()).copied());
      match action {
        Some(action) => action::post(action),
        None => workbench_shared::log::write(
          "shortcuts",
          &format!("ignoring hotkey {} with no binding", event.id()),
        ),
      }
    }));

    Ok(Self {
      manager,
      registered: Vec::new(),
    })
  }

  /// Replaces every shortcut with what is currently stored.
  ///
  /// Individual failures are logged and skipped rather than aborting: an accelerator another
  /// application already owns is a normal thing to hit, and losing the other three shortcuts
  /// over it would be a much worse outcome than losing the one that collided.
  pub fn apply_stored(&mut self) {
    let stored = workbench_shared::shortcuts::read_from_disk();

    if !self.registered.is_empty() {
      if let Err(error) = self.manager.unregister_all(&self.registered) {
        workbench_shared::log::write(
          "shortcuts",
          &format!("failed to release the previous shortcuts: {error}"),
        );
      }
      self.registered.clear();
    }
    if let Ok(mut bindings) = bindings().lock() {
      bindings.clear();
    }

    let mut applied = 0_usize;
    for shortcut in stored {
      let Some(action) = action::from_shortcut_action_id(&shortcut.action_id) else {
        workbench_shared::log::write(
          "shortcuts",
          &format!("no action for {}, skipping", shortcut.action_id),
        );
        continue;
      };
      let hotkey = match shortcut.accelerator.parse::<HotKey>() {
        Ok(hotkey) => hotkey,
        Err(error) => {
          workbench_shared::log::write(
            "shortcuts",
            &format!("invalid accelerator {}: {error}", shortcut.accelerator),
          );
          continue;
        }
      };

      match self.manager.register(hotkey) {
        Ok(()) => {
          if let Ok(mut bindings) = bindings().lock() {
            bindings.insert(hotkey.id(), action);
          }
          self.registered.push(hotkey);
          applied += 1;
        }
        Err(error) => {
          workbench_shared::log::write(
            "shortcuts",
            &format!(
              "could not register {} for {}: {error}",
              shortcut.accelerator, shortcut.action_id
            ),
          );
        }
      }
    }

    workbench_shared::log::write("shortcuts", &format!("registered {applied} global shortcuts"));
  }
}

impl Drop for Hotkeys {
  fn drop(&mut self) {
    if !self.registered.is_empty() {
      let _ = self.manager.unregister_all(&self.registered);
    }
  }
}

#[cfg(test)]
mod tests {
  use global_hotkey::hotkey::HotKey;

  /// The stored accelerators are the strings the UI produces and the app used to hand to
  /// Tauri. If this crate parsed them differently, every shortcut would silently stop.
  #[test]
  fn the_default_accelerators_all_parse() {
    for shortcut in workbench_shared::shortcuts::defaults() {
      assert!(
        shortcut.accelerator.parse::<HotKey>().is_ok(),
        "{} should parse",
        shortcut.accelerator
      );
    }
  }

  #[test]
  fn the_same_accelerator_produces_the_same_id() {
    // Bindings are keyed on the id the event carries, so two spellings of one accelerator
    // must not land on two entries.
    let a = "Ctrl+Alt+KeyN".parse::<HotKey>().expect("should parse");
    let b = "CTRL+ALT+KeyN".parse::<HotKey>().expect("should parse");
    assert_eq!(a.id(), b.id());
  }
}
