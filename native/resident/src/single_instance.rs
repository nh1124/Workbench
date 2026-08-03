//! One resident per machine.
//!
//! Two residents would each put an icon in the tray, and only one of them could hold any
//! given global shortcut — so the second would look identical to the first while doing
//! nothing. The install path makes this easy to hit: the installer starts the resident, and
//! so does the next login.

#[cfg(windows)]
mod platform {
  use std::iter;
  use std::ptr;

  use windows_sys::Win32::Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, HANDLE};
  use windows_sys::Win32::System::Threading::CreateMutexW;

  /// `Local\` rather than `Global\`: the resident is per-user, and a second signed-in user
  /// on the same machine is entitled to their own.
  const INSTANCE_MUTEX_NAME: &str = r"Local\workbench-resident-instance";

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

  /// Returns the lock, or `None` when another resident already holds it.
  pub fn acquire() -> Option<InstanceLock> {
    use windows_sys::Win32::Foundation::GetLastError;

    let name = INSTANCE_MUTEX_NAME
      .encode_utf16()
      .chain(iter::once(0))
      .collect::<Vec<_>>();
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
}

#[cfg(not(windows))]
mod platform {
  pub struct InstanceLock;

  pub fn acquire() -> Option<InstanceLock> {
    Some(InstanceLock)
  }
}

pub struct InstanceLock {
  _inner: platform::InstanceLock,
}

pub fn acquire() -> Option<InstanceLock> {
  platform::acquire().map(|inner| InstanceLock { _inner: inner })
}

#[cfg(all(test, windows))]
mod tests {
  use super::*;

  #[test]
  fn a_second_lock_is_refused_while_the_first_is_held() {
    let first = acquire().expect("the first resident should get the lock");
    assert!(
      acquire().is_none(),
      "a second resident must not start alongside the first"
    );
    drop(first);
    assert!(
      acquire().is_some(),
      "the lock should be available once the first resident exits"
    );
  }
}
