//! Platform-specific secure credential storage.
//!
//! On Windows, credentials are stored in the Windows Credential Manager.
//! On other platforms, storage is not supported and operations return errors.

#[cfg(target_os = "windows")]
mod platform {
  use std::ptr::null_mut;
  use windows_sys::Win32::Foundation::{GetLastError, FILETIME, ERROR_NOT_FOUND};
  use windows_sys::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
  };

  const TARGET_NAME: &str = "Workbench.Session";

  fn to_wide_null(input: &str) -> Vec<u16> {
    input.encode_utf16().chain(std::iter::once(0)).collect()
  }

  pub fn save(session_json: &str) -> Result<(), String> {
    let target_name = to_wide_null(TARGET_NAME);
    let mut bytes = session_json.as_bytes().to_vec();

    let mut credential = CREDENTIALW {
      Flags: 0,
      Type: CRED_TYPE_GENERIC,
      TargetName: target_name.as_ptr() as *mut u16,
      Comment: null_mut(),
      LastWritten: FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
      },
      CredentialBlobSize: bytes.len() as u32,
      CredentialBlob: bytes.as_mut_ptr(),
      Persist: CRED_PERSIST_LOCAL_MACHINE,
      AttributeCount: 0,
      Attributes: null_mut(),
      TargetAlias: null_mut(),
      UserName: null_mut(),
    };

    let ok = unsafe { CredWriteW(&mut credential as *mut CREDENTIALW, 0) };
    if ok == 0 {
      let code = unsafe { GetLastError() };
      return Err(format!("CredWriteW failed with code {}", code));
    }

    Ok(())
  }

  pub fn read() -> Result<Option<String>, String> {
    let target_name = to_wide_null(TARGET_NAME);
    let mut credential_ptr: *mut CREDENTIALW = null_mut();

    let ok = unsafe { CredReadW(target_name.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential_ptr as *mut *mut CREDENTIALW) };
    if ok == 0 {
      let code = unsafe { GetLastError() };
      if code == ERROR_NOT_FOUND {
        return Ok(None);
      }
      return Err(format!("CredReadW failed with code {}", code));
    }

    if credential_ptr.is_null() {
      return Ok(None);
    }

    let result = unsafe {
      let cred = &*credential_ptr;
      let blob = std::slice::from_raw_parts(cred.CredentialBlob, cred.CredentialBlobSize as usize);
      String::from_utf8(blob.to_vec()).map_err(|error| format!("Credential content is not valid UTF-8: {}", error))
    };

    unsafe {
      CredFree(credential_ptr as *mut _);
    }

    result.map(Some)
  }

  pub fn clear() -> Result<(), String> {
    let target_name = to_wide_null(TARGET_NAME);
    let ok = unsafe { CredDeleteW(target_name.as_ptr(), CRED_TYPE_GENERIC, 0) };
    if ok == 0 {
      let code = unsafe { GetLastError() };
      if code == ERROR_NOT_FOUND {
        return Ok(());
      }
      return Err(format!("CredDeleteW failed with code {}", code));
    }
    Ok(())
  }
}

#[cfg(not(target_os = "windows"))]
mod platform {
  pub fn save(_session_json: &str) -> Result<(), String> {
    Err("secure session storage is supported only on Windows".to_string())
  }

  pub fn read() -> Result<Option<String>, String> {
    Ok(None)
  }

  pub fn clear() -> Result<(), String> {
    Ok(())
  }
}

pub fn save(session_json: &str) -> Result<(), String> {
  platform::save(session_json)
}

pub fn read() -> Result<Option<String>, String> {
  platform::read()
}

pub fn clear() -> Result<(), String> {
  platform::clear()
}
