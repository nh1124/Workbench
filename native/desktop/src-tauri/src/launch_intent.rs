//! What a launch of this executable is asking for.
//!
//! The resident holds the global shortcuts now, and it cannot open a window inside an app's
//! process — so it launches the executable with a flag instead. When an instance is already
//! running, `tauri-plugin-single-instance` routes the arguments into it rather than starting
//! a second process, which means one flag covers both "open it" and "it is already open,
//! give me another window".
//!
//! Before this, the single-instance handler only ever opened a main window, and a launch
//! carrying `quick-note-window=1` reached it and did nothing at all.

use crate::window;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LaunchIntent {
  MainWindow,
  QuickNote,
  Calendar,
}

/// Flags the resident passes. Matched as substrings of the whole argument so that both
/// `--quick-note-window=1` and a bare `quick-note-window=1` work, which is what the previous
/// argument check accepted.
const QUICK_NOTE_FLAG: &str = "quick-note-window=1";
const CALENDAR_FLAG: &str = "calendar-window=1";

/// Where the calendar window points. Kept beside the flag it answers to: the resident only
/// says "calendar", and the route is the app's business.
pub const CALENDAR_URL: &str = "/tasks/calendar";

pub fn from_args(argv: &[String]) -> LaunchIntent {
  let normalized: Vec<String> = argv.iter().map(|arg| arg.to_ascii_lowercase()).collect();
  if normalized.iter().any(|arg| arg.contains(QUICK_NOTE_FLAG)) {
    return LaunchIntent::QuickNote;
  }
  if normalized.iter().any(|arg| arg.contains(CALENDAR_FLAG)) {
    return LaunchIntent::Calendar;
  }
  LaunchIntent::MainWindow
}

/// Opens what a launch asked for, from a process that is already running.
pub fn open_for(app: &tauri::AppHandle, intent: LaunchIntent) {
  let result = match intent {
    LaunchIntent::MainWindow => {
      window::build_logged(app, "main window (second launch)", window::open_new_main_window)
    }
    LaunchIntent::QuickNote => window::build_logged(app, "quick note window (second launch)", |app| {
      window::open_new_quick_note_window(app)
    }),
    LaunchIntent::Calendar => window::build_logged(app, "calendar window (second launch)", |app| {
      window::open_calendar_window(app, CALENDAR_URL)
    }),
  };
  if let Err(error) = result {
    crate::applog::write(app, "launch", &format!("second launch failed: {error}"));
  }
}

/// Opens what a launch asked for, during this process's own startup.
///
/// The calendar window navigates relative to an existing window's URL, so it cannot be the
/// first thing built. A main window is opened first and the calendar joins it — which also
/// leaves something on screen if the calendar route itself fails.
pub fn open_at_startup(app: &tauri::AppHandle, intent: LaunchIntent) -> Result<(), String> {
  match intent {
    LaunchIntent::MainWindow => window::open_new_main_window(app),
    LaunchIntent::QuickNote => window::build_logged(app, "quick note window (startup)", |app| {
      window::open_new_quick_note_window(app)
    }),
    LaunchIntent::Calendar => {
      window::open_new_main_window(app)?;
      window::build_logged(app, "calendar window (startup)", |app| {
        window::open_calendar_window(app, CALENDAR_URL)
      })
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
  }

  #[test]
  fn a_bare_launch_opens_a_main_window() {
    assert_eq!(
      from_args(&args(&["C:\\Program Files\\Workbench Native.exe"])),
      LaunchIntent::MainWindow
    );
  }

  #[test]
  fn the_quick_note_flag_is_recognised_with_or_without_dashes() {
    assert_eq!(
      from_args(&args(&["exe", "--quick-note-window=1"])),
      LaunchIntent::QuickNote
    );
    assert_eq!(
      from_args(&args(&["exe", "quick-note-window=1"])),
      LaunchIntent::QuickNote
    );
    assert_eq!(
      from_args(&args(&["exe", "--QUICK-NOTE-WINDOW=1"])),
      LaunchIntent::QuickNote
    );
  }

  #[test]
  fn the_calendar_flag_is_recognised() {
    assert_eq!(
      from_args(&args(&["exe", "--calendar-window=1"])),
      LaunchIntent::Calendar
    );
  }

  #[test]
  fn quick_note_wins_when_both_flags_somehow_arrive() {
    // Not something the resident does, but the order has to be decided somewhere rather
    // than depending on which flag the caller happened to put first.
    assert_eq!(
      from_args(&args(&["exe", "--calendar-window=1", "--quick-note-window=1"])),
      LaunchIntent::QuickNote
    );
  }

  #[test]
  fn an_unrelated_argument_does_not_trigger_a_flag() {
    assert_eq!(
      from_args(&args(&["exe", "--verbose", "C:\\notes\\calendar-window.md"])),
      LaunchIntent::MainWindow
    );
  }
}
