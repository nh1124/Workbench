//! Starting the resident when the user signs in.
//!
//! Written straight to the `Run` key rather than through a plugin. `tauri-plugin-autostart`
//! is the usual answer and it wraps exactly this, but it needs a `tauri::Runtime` and the
//! resident has none. The key it would write is the one written here, so a machine that had
//! the plugin's entry and now has this one sees no difference.
//!
//! The uninstaller already deletes this value (`installer.nsi`, the `DeleteRegValue` beside
//! the uninstall keys), so nothing is left behind after a removal.

/// Value name under `Run`. Must match what the NSIS uninstaller deletes, which is the
/// product name.
#[cfg(windows)]
const RUN_VALUE_NAME: &str = "Workbench Native";
#[cfg(windows)]
const RUN_KEY_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

#[cfg(windows)]
mod platform {
  use std::ffi::OsString;
  use std::os::windows::ffi::{OsStrExt, OsStringExt};

  use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
  use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW,
    RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ, KEY_WRITE, REG_OPTION_NON_VOLATILE,
    REG_SZ,
  };

  fn to_wide_null(value: &str) -> Vec<u16> {
    OsString::from(value)
      .encode_wide()
      .chain(std::iter::once(0))
      .collect()
  }

  /// The command the Run key stores.
  ///
  /// Quoted because the install directory contains a space (`Workbench Native`), and an
  /// unquoted path there is read as a command plus arguments.
  pub fn run_command() -> Result<String, String> {
    let exe = std::env::current_exe()
      .map_err(|error| format!("failed to resolve the resident executable: {error}"))?;
    Ok(format!("\"{}\"", exe.display()))
  }

  fn open_run_key(access: u32) -> Result<HKEY, String> {
    let path = to_wide_null(super::RUN_KEY_PATH);
    let mut key: HKEY = std::ptr::null_mut();
    let status = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, path.as_ptr(), 0, access, &mut key) };
    if status != ERROR_SUCCESS {
      return Err(format!("failed to open the Run key: error {status}"));
    }
    Ok(key)
  }

  fn create_run_key() -> Result<HKEY, String> {
    let path = to_wide_null(super::RUN_KEY_PATH);
    let mut key: HKEY = std::ptr::null_mut();
    let status = unsafe {
      RegCreateKeyExW(
        HKEY_CURRENT_USER,
        path.as_ptr(),
        0,
        std::ptr::null(),
        REG_OPTION_NON_VOLATILE,
        KEY_WRITE,
        std::ptr::null(),
        &mut key,
        std::ptr::null_mut(),
      )
    };
    if status != ERROR_SUCCESS {
      return Err(format!("failed to create the Run key: error {status}"));
    }
    Ok(key)
  }

  pub fn read() -> Result<Option<String>, String> {
    let key = open_run_key(KEY_READ)?;
    let name = to_wide_null(super::RUN_VALUE_NAME);

    let mut size: u32 = 0;
    let status = unsafe {
      RegQueryValueExW(
        key,
        name.as_ptr(),
        std::ptr::null(),
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        &mut size,
      )
    };
    if status == ERROR_FILE_NOT_FOUND {
      unsafe { RegCloseKey(key) };
      return Ok(None);
    }
    if status != ERROR_SUCCESS {
      unsafe { RegCloseKey(key) };
      return Err(format!("failed to size the Run value: error {status}"));
    }

    let mut buffer = vec![0_u8; size as usize];
    let status = unsafe {
      RegQueryValueExW(
        key,
        name.as_ptr(),
        std::ptr::null(),
        std::ptr::null_mut(),
        buffer.as_mut_ptr(),
        &mut size,
      )
    };
    unsafe { RegCloseKey(key) };
    if status != ERROR_SUCCESS {
      return Err(format!("failed to read the Run value: error {status}"));
    }

    // REG_SZ is UTF-16 and may or may not include its terminator in the reported size.
    buffer.truncate(size as usize);
    let wide: Vec<u16> = buffer
      .chunks_exact(2)
      .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
      .take_while(|unit| *unit != 0)
      .collect();
    Ok(Some(OsString::from_wide(&wide).to_string_lossy().into_owned()))
  }

  pub fn enable(command: &str) -> Result<(), String> {
    let key = create_run_key()?;
    let name = to_wide_null(super::RUN_VALUE_NAME);
    let value = to_wide_null(command);
    let bytes = std::mem::size_of_val(value.as_slice()) as u32;
    let status = unsafe {
      RegSetValueExW(
        key,
        name.as_ptr(),
        0,
        REG_SZ,
        value.as_ptr() as *const u8,
        bytes,
      )
    };
    unsafe { RegCloseKey(key) };
    if status != ERROR_SUCCESS {
      return Err(format!("failed to write the Run value: error {status}"));
    }
    Ok(())
  }

  pub fn disable() -> Result<(), String> {
    let key = match open_run_key(KEY_WRITE) {
      Ok(key) => key,
      // No Run key at all is the same outcome the caller wanted.
      Err(_) => return Ok(()),
    };
    let name = to_wide_null(super::RUN_VALUE_NAME);
    let status = unsafe { RegDeleteValueW(key, name.as_ptr()) };
    unsafe { RegCloseKey(key) };
    if status == ERROR_SUCCESS || status == ERROR_FILE_NOT_FOUND {
      return Ok(());
    }
    Err(format!("failed to delete the Run value: error {status}"))
  }
}

#[cfg(not(windows))]
mod platform {
  pub fn run_command() -> Result<String, String> {
    Err("start at login is implemented for Windows only".to_string())
  }
  pub fn read() -> Result<Option<String>, String> {
    Ok(None)
  }
  pub fn enable(_command: &str) -> Result<(), String> {
    Err("start at login is implemented for Windows only".to_string())
  }
  pub fn disable() -> Result<(), String> {
    Ok(())
  }
}

/// Whether the resident is set to start at login.
pub fn is_enabled() -> bool {
  matches!(platform::read(), Ok(Some(_)))
}

pub fn set_enabled(enabled: bool) -> Result<(), String> {
  if enabled {
    platform::enable(&platform::run_command()?)
  } else {
    platform::disable()
  }
}

/// Rewrites the stored command when it no longer points at this executable.
///
/// An update that changes the install directory would otherwise leave the Run key aimed at
/// a path that no longer exists, and the failure is invisible: nothing starts at login and
/// there is no error anywhere, because nothing ran to produce one.
pub fn refresh_if_stale() {
  let Ok(Some(stored)) = platform::read() else {
    return;
  };
  let Ok(expected) = platform::run_command() else {
    return;
  };
  if stored == expected {
    return;
  }
  match platform::enable(&expected) {
    Ok(()) => workbench_shared::log::write(
      "autostart",
      &format!("repointed start-at-login from {stored} to {expected}"),
    ),
    Err(error) => workbench_shared::log::write(
      "autostart",
      &format!("could not repoint start-at-login: {error}"),
    ),
  }
}

#[cfg(all(test, windows))]
mod tests {
  use super::*;

  /// Round-trips through the real registry under a value name the product owns. It restores
  /// whatever was there, so running the suite does not change whether Workbench starts at
  /// login on the machine running it.
  #[test]
  fn the_run_value_round_trips() {
    let original = platform::read().expect("the Run key should be readable");

    platform::enable("\"C:\\test\\resident.exe\"").expect("the value should be writable");
    assert_eq!(
      platform::read().expect("the value should be readable").as_deref(),
      Some("\"C:\\test\\resident.exe\"")
    );
    assert!(is_enabled());

    platform::disable().expect("the value should be deletable");
    assert_eq!(platform::read().expect("a missing value is not an error"), None);
    assert!(!is_enabled());

    // Deleting something that is already gone must stay quiet, or a second "off" errors.
    platform::disable().expect("deleting twice should be fine");

    if let Some(original) = original {
      platform::enable(&original).expect("the original value should be restorable");
    }
  }

  #[test]
  fn the_stored_command_is_quoted() {
    // The install directory has a space in it, so an unquoted path would be read as a
    // command plus an argument and nothing would start.
    let command = platform::run_command().expect("the executable path should resolve");
    assert!(command.starts_with('"'), "got: {command}");
    assert!(command.ends_with('"'), "got: {command}");
  }
}
