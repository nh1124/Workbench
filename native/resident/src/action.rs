//! What the tray and the shortcuts ask for, and how it reaches the loop.
//!
//! Tray clicks, menu picks and hotkeys all arrive inside `DispatchMessageW`, on the loop
//! thread but nested in whatever the window procedure is doing. Rather than act from there,
//! each handler drops an [`Action`] in this queue and wakes the loop, which runs it at the
//! top level. That keeps re-registering a hotkey from happening inside the callback the
//! hotkey itself fired.

use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};

use crate::apps::App;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Action {
  Open(App),
  QuickNote,
  Calendar,
  OpenDaemonLog,
  OpenAppLog,
  RestartDaemon,
  ToggleAutostart,
  Quit,
}

fn queue() -> &'static Mutex<VecDeque<Action>> {
  static QUEUE: OnceLock<Mutex<VecDeque<Action>>> = OnceLock::new();
  QUEUE.get_or_init(|| Mutex::new(VecDeque::new()))
}

/// Queues an action and wakes the loop. Safe to call from any thread.
pub fn post(action: Action) {
  if let Ok(mut queue) = queue().lock() {
    queue.push_back(action);
  }
  crate::msgloop::wake();
}

/// Takes everything queued so far.
pub fn drain() -> Vec<Action> {
  let Ok(mut queue) = queue().lock() else {
    return Vec::new();
  };
  queue.drain(..).collect()
}

/// Which action a global shortcut's action id means.
///
/// Unknown ids are ignored rather than guessed at: they come from stored preferences a newer
/// build could have written, and firing the wrong window would be worse than doing nothing.
pub fn from_shortcut_action_id(action_id: &str) -> Option<Action> {
  match action_id {
    "new_window" => Some(Action::Open(App::Main)),
    "quick_note" | "quick_note_alt" => Some(Action::QuickNote),
    "open_calendar_window" => Some(Action::Calendar),
    _ => None,
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn every_default_shortcut_maps_to_an_action() {
    // A default the resident cannot act on would register a hotkey that does nothing.
    for shortcut in workbench_shared::shortcuts::defaults() {
      assert!(
        from_shortcut_action_id(&shortcut.action_id).is_some(),
        "{} has no action",
        shortcut.action_id
      );
    }
  }

  #[test]
  fn both_quick_note_bindings_open_the_same_window() {
    assert_eq!(
      from_shortcut_action_id("quick_note"),
      from_shortcut_action_id("quick_note_alt")
    );
  }

  #[test]
  fn an_unknown_action_id_is_ignored() {
    assert_eq!(from_shortcut_action_id("open_the_pod_bay_doors"), None);
  }

  #[test]
  fn the_queue_drains_in_order_and_empties() {
    // `post` also wakes the loop, which is a no-op before one is running.
    post(Action::QuickNote);
    post(Action::Open(App::Tasks));
    assert_eq!(drain(), vec![Action::QuickNote, Action::Open(App::Tasks)]);
    assert!(drain().is_empty());
  }
}
