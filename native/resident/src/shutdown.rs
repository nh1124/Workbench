//! Closing the Workbench apps when the user quits from the tray.
//!
//! "Quit Workbench" means all of it. Stopping the sync daemon and leaving windows open put
//! the apps in the one state they cannot work in — a dead local API, errors on screen, and
//! nothing left in the tray to bring the daemon back.
//!
//! The apps are asked rather than killed: `WM_CLOSE` is the message the window's own close
//! button sends, so an app shuts down through the path it already handles.
//!
//! Which windows to ask is decided by the executable behind them, not by the daemon's lease
//! registry. The registry was the obvious source — every app takes a lease and reports its
//! pid — but it is only readable while the daemon is answering, and "the daemon is already
//! stopped" is exactly a case where windows are left open and need closing.

use std::collections::HashSet;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use crate::apps::App;

/// How long to wait for the windows to go before stopping the daemon anyway.
///
/// Short on purpose: this is the quit path, and an app that will not close must not leave
/// the user staring at a tray icon that has stopped responding.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);
const CLOSE_POLL_INTERVAL: Duration = Duration::from_millis(200);

/// Full paths of every Workbench app installed beside this executable.
///
/// Full paths rather than file names: a window belonging to some other program that happens
/// to be called `Workbench Tasks.exe` is not ours to close.
fn app_executable_paths() -> Vec<PathBuf> {
  [App::Main, App::Tasks, App::Notes, App::Artifacts]
    .into_iter()
    .filter_map(|app| crate::apps::locate(app).ok())
    .collect()
}

/// Windows compares paths case-insensitively, and the case a process reports for its own
/// image is not necessarily the case the install wrote.
fn normalize(path: &std::path::Path) -> String {
  path.to_string_lossy().to_ascii_lowercase()
}

fn is_workbench_app(image: &std::path::Path, known: &HashSet<String>) -> bool {
  known.contains(&normalize(image))
}

/// How many Workbench app windows are open right now.
///
/// This is the resident's answer to "is anyone using Workbench". It counts windows rather
/// than processes for the same reason the lease does: a process can outlive its windows.
pub fn open_app_window_count() -> usize {
  let known: HashSet<String> = app_executable_paths().iter().map(|p| normalize(p)).collect();
  if known.is_empty() {
    return 0;
  }
  platform::count_open(&known)
}

/// Asks every Workbench app window to close, and waits until they are gone or time runs out.
///
/// Never fails the quit: whatever happens here, the daemon still has to be stopped and this
/// process still has to exit.
pub fn close_apps() {
  let known: HashSet<String> = app_executable_paths().iter().map(|p| normalize(p)).collect();
  if known.is_empty() {
    workbench_shared::log::write("shutdown", "no installed apps to close");
    return;
  }

  let asked = platform::request_close(&known);
  if asked == 0 {
    return;
  }
  workbench_shared::log::write("shutdown", &format!("asked {asked} app window(s) to close"));

  let deadline = Instant::now() + CLOSE_TIMEOUT;
  while Instant::now() < deadline {
    std::thread::sleep(CLOSE_POLL_INTERVAL);
    if platform::count_open(&known) == 0 {
      workbench_shared::log::write("shutdown", "every app window closed");
      return;
    }
  }

  workbench_shared::log::write(
    "shutdown",
    "some app windows did not close in time; stopping the daemon anyway",
  );
}

#[cfg(windows)]
mod platform {
  use std::collections::HashSet;
  use std::path::PathBuf;

  use windows_sys::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM};
  use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
  };
  use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowThreadProcessId, IsWindowVisible, PostMessageW, WM_CLOSE,
  };

  /// Full path of the executable behind a process id.
  fn process_image_path(pid: u32) -> Option<PathBuf> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;

    // Limited information is enough for the image path and is granted for processes this
    // user owns without any elevation.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
      return None;
    }

    let mut buffer = [0_u16; 32768];
    let mut length = buffer.len() as u32;
    let ok = unsafe { QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut length) };
    unsafe { CloseHandle(handle) };
    if ok == 0 {
      return None;
    }
    Some(PathBuf::from(OsString::from_wide(
      &buffer[..length as usize],
    )))
  }

  struct Visit {
    known: HashSet<String>,
    /// Post `WM_CLOSE` as well as counting, rather than only counting.
    close: bool,
    matched: usize,
  }

  unsafe extern "system" fn visit_window(window: HWND, state: LPARAM) -> BOOL {
    let visit = unsafe { &mut *(state as *mut Visit) };

    // Only visible top-level windows. Every GUI toolkit keeps hidden message-only windows
    // around, and asking those to close achieves nothing while looking like it did — which
    // would also make the wait below never finish.
    if unsafe { IsWindowVisible(window) } == 0 {
      return 1;
    }

    let mut pid: u32 = 0;
    unsafe { GetWindowThreadProcessId(window, &mut pid) };
    if pid == 0 || pid == std::process::id() {
      return 1;
    }
    let Some(image) = process_image_path(pid) else {
      return 1;
    };
    if !super::is_workbench_app(&image, &visit.known) {
      return 1;
    }

    visit.matched += 1;
    if visit.close {
      // Posted, not sent: this must not block on an app that is busy.
      unsafe { PostMessageW(window, WM_CLOSE, 0, 0) };
    }
    1
  }

  fn enumerate(known: &HashSet<String>, close: bool) -> usize {
    let mut visit = Visit {
      known: known.clone(),
      close,
      matched: 0,
    };
    unsafe {
      EnumWindows(Some(visit_window), &mut visit as *mut Visit as isize);
    }
    visit.matched
  }

  /// Posts `WM_CLOSE` to every visible top-level window of a Workbench app.
  pub fn request_close(known: &HashSet<String>) -> usize {
    enumerate(known, true)
  }

  /// How many Workbench app windows are still on screen.
  pub fn count_open(known: &HashSet<String>) -> usize {
    enumerate(known, false)
  }
}

#[cfg(not(windows))]
mod platform {
  use std::collections::HashSet;

  pub fn request_close(_known: &HashSet<String>) -> usize {
    0
  }

  pub fn count_open(_known: &HashSet<String>) -> usize {
    0
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn known(paths: &[&str]) -> HashSet<String> {
    paths
      .iter()
      .map(|path| normalize(std::path::Path::new(path)))
      .collect()
  }

  #[test]
  fn an_app_is_recognised_regardless_of_case() {
    let installed = known(&["C:\\Program Files\\Workbench Native\\Workbench Tasks.exe"]);
    assert!(is_workbench_app(
      std::path::Path::new("c:\\program files\\workbench native\\workbench tasks.exe"),
      &installed
    ));
  }

  #[test]
  fn a_same_named_executable_elsewhere_is_not_ours() {
    // Matching on the file name alone would close someone else's window.
    let installed = known(&["C:\\Program Files\\Workbench Native\\Workbench Tasks.exe"]);
    assert!(!is_workbench_app(
      std::path::Path::new("D:\\Elsewhere\\Workbench Tasks.exe"),
      &installed
    ));
  }

  #[test]
  fn an_unrelated_program_is_not_ours() {
    let installed = known(&["C:\\Program Files\\Workbench Native\\workbench-native.exe"]);
    assert!(!is_workbench_app(
      std::path::Path::new("C:\\Windows\\explorer.exe"),
      &installed
    ));
  }

  #[test]
  fn nothing_installed_means_nothing_to_close() {
    // `locate` returns an error for every app when run from a test binary, so this also
    // covers the real "no apps found" path rather than a stub.
    assert!(app_executable_paths().is_empty());
    assert!(!is_workbench_app(
      std::path::Path::new("C:\\anything.exe"),
      &HashSet::new()
    ));
  }
}
