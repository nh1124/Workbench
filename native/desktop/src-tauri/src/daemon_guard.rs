//! Cross-process serialization for the sync daemon check-and-spawn sequence.

#[cfg(target_os = "windows")]
mod platform {
  use std::{iter, ptr};

  use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, WAIT_ABANDONED, WAIT_OBJECT_0},
    System::Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject},
  };

  const DAEMON_LAUNCH_MUTEX_NAME: &str = r"Local\workbench-sync-daemon-launch";
  const DAEMON_LAUNCH_TIMEOUT_MS: u32 = 10_000;

  pub struct DaemonLaunchGuard {
    handle: HANDLE,
  }

  impl Drop for DaemonLaunchGuard {
    fn drop(&mut self) {
      unsafe {
        ReleaseMutex(self.handle);
        CloseHandle(self.handle);
      }
    }
  }

  pub fn acquire() -> Option<DaemonLaunchGuard> {
    acquire_with_timeout(DAEMON_LAUNCH_TIMEOUT_MS)
  }

  pub(super) fn acquire_with_timeout(timeout_ms: u32) -> Option<DaemonLaunchGuard> {
    let name = DAEMON_LAUNCH_MUTEX_NAME
      .encode_utf16()
      .chain(iter::once(0))
      .collect::<Vec<_>>();
    let handle = unsafe { CreateMutexW(ptr::null(), 0, name.as_ptr()) };
    if handle.is_null() {
      eprintln!("[workbench-native] failed to create sync daemon launch mutex");
      return None;
    }

    let wait_result = unsafe { WaitForSingleObject(handle, timeout_ms) };
    if wait_result == WAIT_OBJECT_0 || wait_result == WAIT_ABANDONED {
      return Some(DaemonLaunchGuard { handle });
    }

    unsafe {
      CloseHandle(handle);
    }
    eprintln!(
      "[workbench-native] failed to acquire sync daemon launch mutex within {timeout_ms} ms"
    );
    None
  }

}

#[cfg(not(target_os = "windows"))]
mod platform {
  use std::{
    fs::{self, File, OpenOptions},
    io::ErrorKind,
    path::PathBuf,
    time::{Duration, SystemTime},
  };

  const DAEMON_LAUNCH_LOCK_FILE: &str = "workbench-sync-daemon-launch.lock";
  const DAEMON_LAUNCH_STALE_AFTER: Duration = Duration::from_secs(60);

  pub struct DaemonLaunchGuard {
    _file: File,
    path: PathBuf,
  }

  impl Drop for DaemonLaunchGuard {
    fn drop(&mut self) {
      if let Err(error) = fs::remove_file(&self.path) {
        if error.kind() != ErrorKind::NotFound {
          eprintln!(
            "[workbench-native] failed to remove sync daemon launch lock {}: {error}",
            self.path.display()
          );
        }
      }
    }
  }

  pub fn acquire() -> Option<DaemonLaunchGuard> {
    let path = std::env::temp_dir().join(DAEMON_LAUNCH_LOCK_FILE);

    for attempt in 0..=1 {
      match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(file) => {
          return Some(DaemonLaunchGuard { _file: file, path });
        }
        Err(error)
          if attempt == 0
            && error.kind() == ErrorKind::AlreadyExists
            && lock_file_is_stale(&path) =>
        {
          match fs::remove_file(&path) {
            Ok(()) => continue,
            Err(remove_error) if remove_error.kind() == ErrorKind::NotFound => continue,
            Err(remove_error) => {
              eprintln!(
                "[workbench-native] failed to remove stale sync daemon launch lock {}: {remove_error}",
                path.display()
              );
              return None;
            }
          }
        }
        Err(error) => {
          eprintln!(
            "[workbench-native] failed to acquire sync daemon launch lock {}: {error}",
            path.display()
          );
          return None;
        }
      }
    }

    eprintln!(
      "[workbench-native] failed to acquire sync daemon launch lock {}",
      path.display()
    );
    None
  }

  fn lock_file_is_stale(path: &PathBuf) -> bool {
    fs::metadata(path)
      .and_then(|metadata| metadata.modified())
      .ok()
      .and_then(|modified| SystemTime::now().duration_since(modified).ok())
      .is_some_and(|age| age > DAEMON_LAUNCH_STALE_AFTER)
  }

}

pub struct DaemonLaunchGuard {
  _inner: platform::DaemonLaunchGuard,
}

pub fn acquire() -> Option<DaemonLaunchGuard> {
  platform::acquire().map(|guard| DaemonLaunchGuard { _inner: guard })
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::{
    sync::Mutex,
    thread,
    time::{Duration, Instant},
  };

  static TEST_LOCK: Mutex<()> = Mutex::new(());

  #[cfg(target_os = "windows")]
  fn acquire_for_contention_test() -> Option<DaemonLaunchGuard> {
    platform::acquire_with_timeout(100).map(|guard| DaemonLaunchGuard { _inner: guard })
  }

  #[cfg(not(target_os = "windows"))]
  fn acquire_for_contention_test() -> Option<DaemonLaunchGuard> {
    acquire()
  }

  #[test]
  fn launch_guard_can_be_reacquired_after_drop() {
    let _test_lock = TEST_LOCK.lock().expect("test lock should not be poisoned");
    let guard = acquire().expect("launch guard should be acquired");
    drop(guard);
    assert!(acquire().is_some());
  }

  #[test]
  fn launch_guard_reports_contention_from_another_thread() {
    let _test_lock = TEST_LOCK.lock().expect("test lock should not be poisoned");
    let _guard = acquire().expect("launch guard should be acquired");
    let started = Instant::now();
    let contender = thread::spawn(|| acquire_for_contention_test().is_none());

    assert!(contender.join().expect("contender should not panic"));
    assert!(started.elapsed() < Duration::from_secs(2));
  }
}
