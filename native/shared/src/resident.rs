//! Finding, starting and counting the resident.
//!
//! The resident is what puts Workbench in the tray and keeps the sync daemon alive. Both
//! sides need to know about it: the resident itself, to refuse to start twice, and the apps,
//! to make sure it is there at all.
//!
//! That second part is not optional. Quitting from the tray stops the resident, and without
//! this an app opened afterwards would run with no tray icon, no global shortcuts, and
//! nothing keeping the daemon up — a Workbench that looks half-installed until the next
//! sign-in. Opening an app means the user is using Workbench again, so the resident comes
//! back with it.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Base name of the resident executable. Must match the `[[bin]]` name in
/// `native/resident/Cargo.toml`, which is what the Tauri sidecar is installed as.
pub const RESIDENT_BINARY_NAME: &str = "workbench-resident";

/// `CREATE_NO_WINDOW` — the resident is a GUI process, but this keeps a console from ever
/// appearing if it is started from one.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn executable_names() -> Vec<String> {
  let mut names = vec![RESIDENT_BINARY_NAME.to_string()];
  #[cfg(target_os = "windows")]
  names.push(format!("{RESIDENT_BINARY_NAME}.exe"));
  names
}

/// Finds the resident beside the calling executable.
///
/// `extra_roots` is how a Tauri app contributes its resource directory. Everything Workbench
/// installs lands in one directory, so the caller's own directory is normally the answer.
pub fn locate(extra_roots: &[PathBuf]) -> Result<PathBuf, String> {
  let mut roots = extra_roots.to_vec();
  if let Some(parent) = std::env::current_exe()
    .ok()
    .and_then(|path| path.parent().map(Path::to_path_buf))
  {
    roots.push(parent);
  }
  if let Ok(current_dir) = std::env::current_dir() {
    roots.push(current_dir);
  }

  for root in &roots {
    for name in executable_names() {
      let candidate = root.join(&name);
      if candidate.is_file() {
        return Ok(candidate);
      }
    }
  }

  Err(format!(
    "the resident executable was not found; looked for {} in {}",
    executable_names().join(", "),
    roots
      .iter()
      .map(|root| root.display().to_string())
      .collect::<Vec<_>>()
      .join(", ")
  ))
}

/// Starts the resident unless one is already running.
///
/// Returns `true` when this call started it. Racing with another caller is safe: the loser's
/// resident sees the instance lock already held and exits immediately, which is why this
/// checks first rather than needing to.
pub fn ensure_running(extra_roots: &[PathBuf]) -> Result<bool, String> {
  if is_running() {
    return Ok(false);
  }

  let program = locate(extra_roots)?;
  let mut command = Command::new(&program);
  command
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());
  #[cfg(target_os = "windows")]
  {
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NO_WINDOW);
  }

  command
    .spawn()
    .map(|_child| true)
    .map_err(|error| format!("failed to start the resident {}: {error}", program.display()))
}

/// Whether a resident is running on this machine.
pub fn is_running() -> bool {
  platform::instance_lock_is_held()
}

/// Takes the one-resident-per-machine lock. `None` when another resident already holds it.
pub fn acquire_instance_lock() -> Option<InstanceLock> {
  platform::acquire().map(|inner| InstanceLock { _inner: inner })
}

pub struct InstanceLock {
  _inner: platform::InstanceLock,
}

#[cfg(windows)]
mod platform {
  use std::iter;
  use std::ptr;

  use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE};
  use windows_sys::Win32::System::Threading::{CreateMutexW, OpenMutexW};

  /// `Local\` rather than `Global\`: the resident is per-user, and a second signed-in user on
  /// the same machine is entitled to their own.
  const INSTANCE_MUTEX_NAME: &str = r"Local\workbench-resident-instance";
  /// `SYNCHRONIZE` — the least access that still proves the mutex exists. Not re-exported by
  /// windows-sys as a synchronization access right, so it is spelled out here.
  const SYNCHRONIZE: u32 = 0x0010_0000;

  fn wide_name() -> Vec<u16> {
    INSTANCE_MUTEX_NAME
      .encode_utf16()
      .chain(iter::once(0))
      .collect()
  }

  pub struct InstanceLock {
    handle: HANDLE,
  }

  impl Drop for InstanceLock {
    fn drop(&mut self) {
      unsafe {
        CloseHandle(self.handle);
      }
    }
  }

  pub fn acquire() -> Option<InstanceLock> {
    let name = wide_name();
    // Owned on creation, and never released: the lock is the process's lifetime, not a
    // critical section, so ownership only has to outlive the handle.
    let handle = unsafe { CreateMutexW(ptr::null(), 1, name.as_ptr()) };
    if handle.is_null() {
      return None;
    }
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
      unsafe {
        CloseHandle(handle);
      }
      return None;
    }
    Some(InstanceLock { handle })
  }

  pub fn instance_lock_is_held() -> bool {
    let name = wide_name();
    let handle = unsafe { OpenMutexW(SYNCHRONIZE, 0, name.as_ptr()) };
    if handle.is_null() {
      return false;
    }
    unsafe {
      CloseHandle(handle);
    }
    true
  }
}

#[cfg(not(windows))]
mod platform {
  pub struct InstanceLock;

  pub fn acquire() -> Option<InstanceLock> {
    Some(InstanceLock)
  }

  pub fn instance_lock_is_held() -> bool {
    false
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_executable_names_include_the_installed_one() {
    let names = executable_names();
    assert_eq!(names[0], RESIDENT_BINARY_NAME);
    #[cfg(target_os = "windows")]
    assert_eq!(names[1], "workbench-resident.exe");
  }

  #[test]
  fn a_missing_resident_reports_where_it_looked() {
    // Nothing named this sits beside the test binary, so this is the real failure path.
    let error = locate(&[]).unwrap_err();
    assert!(error.contains(RESIDENT_BINARY_NAME), "got: {error}");
    assert!(error.contains("looked for"), "got: {error}");
  }

  #[test]
  fn extra_roots_are_searched_before_the_executable_directory() {
    let extra = PathBuf::from("Z:\\resources\\workbench-resident.exe");
    // Neither exists, but the error lists the roots in the order they were tried.
    let error = locate(&[PathBuf::from("Z:\\resources")]).unwrap_err();
    let extra_root = extra.parent().expect("the extra root has a parent");
    let listed = error
      .split("in ")
      .nth(1)
      .expect("the error lists the roots it tried");
    assert!(
      listed.starts_with(&extra_root.display().to_string()),
      "got: {listed}"
    );
  }

  #[cfg(windows)]
  #[test]
  fn the_instance_lock_is_visible_to_other_processes_while_it_is_held() {
    // `is_running` is what an app uses to decide whether to start a resident, so it has to
    // agree with the lock the resident itself takes.
    //
    // The developer running this very likely has a real resident in their tray, which is
    // the lock being held by another process. That is the same thing this is checking, so
    // it is checked rather than treated as a reason to fail.
    if is_running() {
      assert!(
        acquire_instance_lock().is_none(),
        "a resident is running, so the lock must not be available"
      );
      return;
    }

    let lock = acquire_instance_lock().expect("the lock should be free");
    assert!(is_running());
    assert!(
      acquire_instance_lock().is_none(),
      "a second resident must not get the lock"
    );
    drop(lock);
    assert!(!is_running());
  }
}
