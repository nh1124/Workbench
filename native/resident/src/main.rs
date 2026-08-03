//! Workbench resident: the tray, the global shortcuts, and the sync daemon.
//!
//! The design this implements is "daemon is the service, apps are clients that come and go".
//! It used to be the other way round — the main app held the tray and the shortcuts, so
//! closing it took both away, and the daemon's lifetime was tied to whichever app happened
//! to have started it.
//!
//! This process starts at login, keeps the daemon running, and launches the apps when the
//! tray or a shortcut asks for one. It has no window of its own.

// No console at login. It also means `eprintln!` reaches nobody, which is why everything
// here reports through `workbench_shared::log` instead.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod action;
mod apps;
mod autostart;
mod hotkeys;
mod msgloop;
mod single_instance;
mod tray;

use std::time::{Duration, SystemTime};

use action::Action;
use msgloop::LoopHandler;

/// How often the stored shortcuts are checked for changes.
///
/// Polled rather than watched: the alternative is a directory watch on the config folder,
/// and the whole job is noticing that one small file changed shortly after the user pressed
/// Save in a settings page. Two seconds is imperceptible there and free the rest of the time.
const SHORTCUT_POLL_INTERVAL: Duration = Duration::from_secs(2);

struct Resident {
  tray: tray::Tray,
  /// `None` when the hotkey manager could not be created. The tray is still worth running
  /// on its own — it is the only way to reach or stop this process — so a machine where
  /// global shortcuts are unavailable gets a resident with a menu rather than nothing.
  hotkeys: Option<hotkeys::Hotkeys>,
}

impl Resident {
  fn run_action(&mut self, action: Action) -> bool {
    match action {
      Action::Open(app) => self.launch(app, &[]),
      Action::QuickNote => self.launch(apps::App::Main, &[apps::QUICK_NOTE_FLAG]),
      Action::Calendar => self.launch(apps::App::Main, &[apps::CALENDAR_FLAG]),
      Action::OpenDaemonLog => self.open_log(workbench_shared::daemon::log_path(), "sync daemon"),
      Action::OpenAppLog => self.open_log(workbench_shared::log::path(), "app"),
      Action::RestartDaemon => self.restart_daemon(),
      Action::ToggleAutostart => self.toggle_autostart(),
      Action::Quit => return self.quit(),
    }
    true
  }

  fn launch(&self, app: apps::App, args: &[&str]) {
    // Launch first, then make sure the daemon is up — not the other way round. Starting the
    // daemon waits up to 20 seconds for it to answer, and doing that here would freeze the
    // message loop, which means the tray stops responding for as long as it takes. The app
    // handles a daemon that is not up yet; a dead tray icon is not something it can handle.
    match apps::launch(app, args) {
      Ok(()) => workbench_shared::log::write("launch", &format!("started {}", app.label())),
      Err(error) => workbench_shared::log::write("launch", &error),
    }
    // The daemon may have exited on idle since the last window closed.
    ensure_daemon_off_thread();
  }

  fn open_log(&self, path: Result<std::path::PathBuf, String>, which: &str) {
    let path = match path {
      Ok(path) => path,
      Err(error) => {
        workbench_shared::log::write("tray", &format!("no {which} log path: {error}"));
        return;
      }
    };
    if !path.is_file() {
      workbench_shared::log::write(
        "tray",
        &format!("no {which} log yet at {}", path.display()),
      );
      return;
    }
    if let Err(error) = open_text_file(&path) {
      workbench_shared::log::write("tray", &format!("could not open the {which} log: {error}"));
    }
  }

  /// Stops and restarts the daemon, off the message loop.
  ///
  /// Both halves wait on the loopback port — up to 20 seconds each — so this must not run
  /// where the tray is waiting for it.
  fn restart_daemon(&self) {
    std::thread::spawn(|| {
      workbench_shared::log::write("daemon", "restarting on request from the tray");
      if let Err(error) = workbench_shared::daemon::stop() {
        workbench_shared::log::write("daemon", &format!("could not stop for restart: {error}"));
        return;
      }
      ensure_daemon();
    });
  }

  fn toggle_autostart(&self) {
    let enabled = autostart::is_enabled();
    if let Err(error) = autostart::set_enabled(!enabled) {
      workbench_shared::log::write("autostart", &format!("could not change: {error}"));
    }
    self.tray.refresh_autostart_state();
  }

  /// Ends everything Workbench owns on this machine.
  ///
  /// The daemon goes too. This is the tray's "Quit", the one place a user says they are done
  /// rather than just closing a window, and leaving a sync process behind after it would be
  /// indistinguishable from the quit not having worked.
  ///
  /// Deliberately synchronous, unlike the other daemon calls: the process must not exit
  /// before the daemon has actually gone, or "Quit" leaves the thing it was meant to stop
  /// still running with nothing left to stop it.
  fn quit(&self) -> bool {
    workbench_shared::log::write("tray", "quitting; stopping the sync daemon");
    if let Err(error) = workbench_shared::daemon::stop() {
      workbench_shared::log::write("daemon", &format!("could not stop on quit: {error}"));
    }
    false
  }
}

impl LoopHandler for Resident {
  fn handle_actions(&mut self) -> bool {
    for action in action::drain() {
      if !self.run_action(action) {
        return false;
      }
    }
    true
  }

  fn reload_shortcuts(&mut self) {
    if let Some(hotkeys) = self.hotkeys.as_mut() {
      hotkeys.apply_stored();
    }
  }
}

#[cfg(target_os = "windows")]
fn open_text_file(path: &std::path::Path) -> Result<(), String> {
  // Notepad rather than the shell: `.log` usually has no registered handler on Windows, and
  // `start` then exits having opened nothing, which reads as the menu item being broken.
  std::process::Command::new("notepad.exe")
    .arg(path.as_os_str())
    .spawn()
    .map(|_child| ())
    .map_err(|error| format!("failed to open {}: {error}", path.display()))
}

#[cfg(not(target_os = "windows"))]
fn open_text_file(path: &std::path::Path) -> Result<(), String> {
  std::process::Command::new("xdg-open")
    .arg(path.as_os_str())
    .spawn()
    .map(|_child| ())
    .map_err(|error| format!("failed to open {}: {error}", path.display()))
}

/// Starts the daemon if nothing else has.
///
/// No extra search roots: the sidecar is installed beside this executable, which the shared
/// launcher already looks in.
fn ensure_daemon() {
  match workbench_shared::daemon::start(&[]) {
    Ok(true) => workbench_shared::log::write("daemon", "started the sync daemon"),
    Ok(false) => {}
    Err(error) => workbench_shared::log::write("daemon", &format!("could not start: {error}")),
  }
}

/// [`ensure_daemon`] where the caller must not block — anything reached from the message loop.
fn ensure_daemon_off_thread() {
  std::thread::spawn(ensure_daemon);
}

/// Watches the stored shortcuts for changes made by a settings page in one of the apps.
fn watch_shortcuts() {
  std::thread::spawn(|| {
    let mut last_seen: Option<SystemTime> = shortcuts_modified_at();
    loop {
      std::thread::sleep(SHORTCUT_POLL_INTERVAL);
      let current = shortcuts_modified_at();
      if current != last_seen {
        last_seen = current;
        msgloop::request_shortcut_reload();
      }
    }
  });
}

fn shortcuts_modified_at() -> Option<SystemTime> {
  workbench_shared::shortcuts::shortcuts_path()
    .ok()
    .and_then(|path| std::fs::metadata(path).ok())
    .and_then(|metadata| metadata.modified().ok())
}

fn main() {
  workbench_shared::log::set_process_tag("resident");

  let Some(_instance) = single_instance::acquire() else {
    workbench_shared::log::write("startup", "another resident is already running; exiting");
    return;
  };
  workbench_shared::log::write("startup", "resident starting");

  // An update can move the install directory, which leaves the Run key aimed at a path that
  // no longer exists — and nothing reports that, because nothing runs.
  autostart::refresh_if_stale();

  // The daemon takes a few seconds to become observable and the tray should not wait for it:
  // an icon that appears late looks like a failed login item.
  ensure_daemon_off_thread();

  let tray = match tray::Tray::new() {
    Ok(tray) => tray,
    Err(error) => {
      // Without a tray icon there is no way to reach or stop this process, so there is no
      // point carrying on: the shortcuts alone would be a process the user cannot see.
      workbench_shared::log::write("startup", &format!("tray icon failed, exiting: {error}"));
      return;
    }
  };

  let hotkeys = match hotkeys::Hotkeys::new() {
    Ok(mut hotkeys) => {
      hotkeys.apply_stored();
      watch_shortcuts();
      Some(hotkeys)
    }
    Err(error) => {
      workbench_shared::log::write("startup", &format!("global shortcuts unavailable: {error}"));
      None
    }
  };

  let mut resident = Resident { tray, hotkeys };
  msgloop::run(&mut resident);
  workbench_shared::log::write("shutdown", "resident stopped");
}
