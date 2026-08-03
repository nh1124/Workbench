//! Launching the Workbench apps.
//!
//! Every app is a sibling of this executable — the installer puts them all in one directory
//! — so one anchor finds them all. Launching is always "start the executable": when an
//! instance is already running, `tauri-plugin-single-instance` turns the second launch into
//! a message to the first, so the same command both opens the app and asks an open one for
//! another window.

use std::path::PathBuf;
use std::process::{Command, Stdio};

use workbench_shared::paths::install_directory;

/// Flags the apps recognise. Kept in step with `launch_intent.rs` in the desktop app.
pub const QUICK_NOTE_FLAG: &str = "--quick-note-window=1";
pub const CALENDAR_FLAG: &str = "--calendar-window=1";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum App {
  Main,
  Tasks,
  Notes,
  Artifacts,
}

impl App {
  pub fn label(self) -> &'static str {
    match self {
      App::Main => "Workbench",
      App::Tasks => "Workbench Tasks",
      App::Notes => "Workbench Notes",
      App::Artifacts => "Workbench Artifacts",
    }
  }

  /// Executable names to try, in order.
  ///
  /// The main app is listed twice on purpose: Tauri names the binary after the Cargo
  /// package (`workbench-native.exe`), but a build configured to name it after the product
  /// would produce the other one, and a resident that silently does nothing is a much worse
  /// outcome than one extra `is_file` check.
  pub fn executable_names(self) -> &'static [&'static str] {
    match self {
      App::Main => &["workbench-native.exe", "Workbench Native.exe"],
      App::Tasks => &["Workbench Tasks.exe"],
      App::Notes => &["Workbench Notes.exe"],
      App::Artifacts => &["Workbench Artifacts.exe"],
    }
  }
}

/// Finds an app's executable next to this one.
///
/// The dedicated apps are optional components, so a missing one is an ordinary state rather
/// than a broken install — the error says which names were tried so the tray entry that did
/// nothing can be explained from the log.
pub fn locate(app: App) -> Result<PathBuf, String> {
  let directory = install_directory()?;
  for name in app.executable_names() {
    let candidate = directory.join(name);
    if candidate.is_file() {
      return Ok(candidate);
    }
  }
  Err(format!(
    "{} is not installed: looked for {} in {}",
    app.label(),
    app.executable_names().join(", "),
    directory.display()
  ))
}

/// Starts an app, optionally asking it for a particular window.
///
/// Deliberately does not wait: the child is a GUI process that outlives this call, and the
/// resident must get straight back to its message loop or the tray stops responding.
pub fn launch(app: App, args: &[&str]) -> Result<(), String> {
  let program = locate(app)?;
  Command::new(&program)
    .args(args)
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .spawn()
    .map(|_child| ())
    .map_err(|error| format!("failed to launch {}: {error}", program.display()))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn every_app_has_at_least_one_executable_name() {
    for app in [App::Main, App::Tasks, App::Notes, App::Artifacts] {
      assert!(
        !app.executable_names().is_empty(),
        "{} needs a name to look for",
        app.label()
      );
      assert!(app
        .executable_names()
        .iter()
        .all(|name| name.ends_with(".exe")));
    }
  }

  #[test]
  fn a_missing_app_reports_what_it_looked_for() {
    // Nothing named this is installed beside the test binary, so this exercises the real
    // failure path rather than a stub.
    let error = locate(App::Tasks).unwrap_err();
    assert!(error.contains("Workbench Tasks.exe"), "got: {error}");
    assert!(error.contains("is not installed"), "got: {error}");
  }

  #[test]
  fn the_app_flags_match_what_the_desktop_app_parses() {
    // `launch_intent::from_args` matches these as lowercase substrings.
    assert!(QUICK_NOTE_FLAG.contains("quick-note-window=1"));
    assert!(CALENDAR_FLAG.contains("calendar-window=1"));
  }
}
