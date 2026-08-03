//! Where the apps and the resident find the things they share.
//!
//! The apps used to get these from Tauri (`app_config_dir()`, `home_dir()`,
//! `download_dir()`). The resident has no Tauri runtime, so these resolve the same
//! locations directly and both sides now go through here. The values must agree exactly:
//! settings, logs and the daemon token are one set of files, and the sync root is one
//! folder that only one of them may be right about.

use std::path::{Path, PathBuf};

/// Identifier of the main app. Every variant already redirects its own identifier-scoped
/// config directory to this one (`variant::shared_config_dir_from` in the desktop app), so
/// the resident joining it lands on the same folder rather than a fifth copy.
pub const MAIN_IDENTIFIER: &str = "com.workbench.desktop";

/// Config directory shared by the resident, the main app and every variant.
///
/// Mirrors what Tauri derives on each platform, so this must be kept beside
/// `shared_config_directory` in the desktop app rather than invented here.
pub fn shared_config_directory() -> Result<PathBuf, String> {
  config_root().map(|root| root.join(MAIN_IDENTIFIER))
}

#[cfg(windows)]
fn config_root() -> Result<PathBuf, String> {
  std::env::var_os("APPDATA")
    .filter(|value| !value.is_empty())
    .map(PathBuf::from)
    .ok_or_else(|| "APPDATA is not set".to_string())
}

#[cfg(target_os = "macos")]
fn config_root() -> Result<PathBuf, String> {
  home_directory().map(|home| home.join("Library").join("Application Support"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn config_root() -> Result<PathBuf, String> {
  if let Some(value) = std::env::var_os("XDG_CONFIG_HOME").filter(|value| !value.is_empty()) {
    return Ok(PathBuf::from(value));
  }
  home_directory().map(|home| home.join(".config"))
}

/// The user's home directory.
#[cfg(windows)]
pub fn home_directory() -> Result<PathBuf, String> {
  std::env::var_os("USERPROFILE")
    .filter(|value| !value.is_empty())
    .map(PathBuf::from)
    .ok_or_else(|| "USERPROFILE is not set".to_string())
}

#[cfg(unix)]
pub fn home_directory() -> Result<PathBuf, String> {
  std::env::var_os("HOME")
    .filter(|value| !value.is_empty())
    .map(PathBuf::from)
    .ok_or_else(|| "HOME is not set".to_string())
}

/// The user's Downloads directory.
///
/// Windows lets this be relocated, and a fair number of people move it off the system
/// drive, so this asks the shell rather than assuming `%USERPROFILE%\Downloads`. That
/// assumption is still the fallback, because a missing Downloads folder must not stop the
/// daemon from starting.
#[cfg(windows)]
pub fn downloads_directory() -> Result<PathBuf, String> {
  known_folder_downloads().or_else(|_| home_directory().map(|home| home.join("Downloads")))
}

#[cfg(unix)]
pub fn downloads_directory() -> Result<PathBuf, String> {
  home_directory().map(|home| home.join("Downloads"))
}

#[cfg(windows)]
fn known_folder_downloads() -> Result<PathBuf, String> {
  use std::os::windows::ffi::OsStringExt;
  use windows_sys::Win32::System::Com::CoTaskMemFree;
  use windows_sys::Win32::UI::Shell::{SHGetKnownFolderPath, FOLDERID_Downloads};

  let mut raw: windows_sys::core::PWSTR = std::ptr::null_mut();
  let result = unsafe {
    SHGetKnownFolderPath(
      &FOLDERID_Downloads,
      0,
      std::ptr::null_mut(),
      &mut raw as *mut windows_sys::core::PWSTR,
    )
  };
  if result < 0 || raw.is_null() {
    return Err(format!("SHGetKnownFolderPath failed with HRESULT {result:#x}"));
  }

  // The shell allocated this; it has to be handed back however the read turns out.
  let mut length = 0_usize;
  while unsafe { *raw.add(length) } != 0 {
    length += 1;
  }
  let wide = unsafe { std::slice::from_raw_parts(raw, length) };
  let path = PathBuf::from(std::ffi::OsString::from_wide(wide));
  unsafe { CoTaskMemFree(raw as *const std::ffi::c_void) };

  Ok(path)
}

/// Renders a path for the environment variables and JSON the daemon reads.
pub fn path_to_string(path: PathBuf) -> String {
  path.to_string_lossy().into_owned()
}

/// Reads a path from an environment variable, treating blank as unset.
pub fn env_path(name: &str) -> Option<PathBuf> {
  std::env::var(name)
    .ok()
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty())
    .map(PathBuf::from)
}

/// Directory this executable lives in — the install directory in a packaged build.
///
/// Everything the resident launches is a sibling of itself: the app executables and the
/// sync daemon are installed side by side, so one anchor locates them all.
pub fn install_directory() -> Result<PathBuf, String> {
  let exe = std::env::current_exe()
    .map_err(|error| format!("failed to resolve the resident executable path: {error}"))?;
  exe
    .parent()
    .map(Path::to_path_buf)
    .ok_or_else(|| "the resident executable has no parent directory".to_string())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_shared_config_directory_ends_at_the_main_identifier() {
    // Whatever the platform root is, the last component decides which app's settings these
    // are, and that is the one thing the apps and the resident must agree on.
    let directory = shared_config_directory().expect("a config root should be resolvable");
    assert_eq!(
      directory.file_name().and_then(|name| name.to_str()),
      Some(MAIN_IDENTIFIER)
    );
  }

  #[test]
  fn the_install_directory_contains_this_executable() {
    let directory = install_directory().expect("the executable should have a parent");
    let exe = std::env::current_exe().expect("the current executable should resolve");
    assert_eq!(exe.parent(), Some(directory.as_path()));
  }
}
