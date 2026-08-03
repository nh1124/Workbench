//! Platform-specific secure credential storage.
//!
//! On Windows, credentials are stored in the Windows Credential Manager.
//! On other platforms, storage is not supported and operations return errors.

const SESSION_TARGET_NAME: &str = "Workbench.Session";
const LOCAL_DAEMON_CLIENT_TARGET_NAME: &str = "Workbench.LocalDaemonClient";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalDaemonClientIdentity {
  pub local_client_id: String,
  pub local_client_token: String,
}

#[cfg(target_os = "windows")]
mod platform {
  use std::ptr::null_mut;
  use windows_sys::Win32::Foundation::{GetLastError, FILETIME, ERROR_NOT_FOUND};
  use windows_sys::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
  };

  fn to_wide_null(input: &str) -> Vec<u16> {
    input.encode_utf16().chain(std::iter::once(0)).collect()
  }

  pub fn save(target: &str, credential_value: &str) -> Result<(), String> {
    let target_name = to_wide_null(target);
    let mut bytes = credential_value.as_bytes().to_vec();

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

  pub fn read(target: &str) -> Result<Option<String>, String> {
    let target_name = to_wide_null(target);
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

  pub fn clear(target: &str) -> Result<(), String> {
    let target_name = to_wide_null(target);
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
  pub fn save(_target: &str, _credential_value: &str) -> Result<(), String> {
    Err("secure session storage is supported only on Windows".to_string())
  }

  pub fn read(_target: &str) -> Result<Option<String>, String> {
    Ok(None)
  }

  pub fn clear(_target: &str) -> Result<(), String> {
    Ok(())
  }
}

fn required_trimmed(value: &str, field_name: &str) -> Result<String, String> {
  let trimmed = value.trim();
  if trimmed.is_empty() {
    Err(format!("{field_name} is required"))
  } else {
    Ok(trimmed.to_string())
  }
}

fn string_field(value: &serde_json::Value, field_name: &str) -> Result<String, String> {
  value
    .get(field_name)
    .and_then(serde_json::Value::as_str)
    .map(|field_value| required_trimmed(field_value, field_name))
    .unwrap_or_else(|| Err(format!("{field_name} is required")))
}

pub fn parse_local_daemon_client_identity(raw: &str) -> Result<LocalDaemonClientIdentity, String> {
  let parsed = serde_json::from_str::<serde_json::Value>(raw)
    .map_err(|error| format!("stored local daemon client identity is not valid JSON: {error}"))?;
  Ok(LocalDaemonClientIdentity {
    local_client_id: string_field(&parsed, "localClientId")?,
    local_client_token: string_field(&parsed, "localClientToken")?,
  })
}

pub fn is_supported() -> bool {
  cfg!(target_os = "windows")
}

pub fn save(session_json: &str) -> Result<(), String> {
  platform::save(SESSION_TARGET_NAME, session_json)
}

pub fn read() -> Result<Option<String>, String> {
  platform::read(SESSION_TARGET_NAME)
}

pub fn clear() -> Result<(), String> {
  platform::clear(SESSION_TARGET_NAME)
}

pub fn save_local_daemon_client_identity(
  local_client_id: &str,
  local_client_token: &str,
) -> Result<(), String> {
  let identity = LocalDaemonClientIdentity {
    local_client_id: required_trimmed(local_client_id, "localClientId")?,
    local_client_token: required_trimmed(local_client_token, "localClientToken")?,
  };
  let serialized = serde_json::json!({
    "localClientId": identity.local_client_id,
    "localClientToken": identity.local_client_token
  })
  .to_string();
  platform::save(LOCAL_DAEMON_CLIENT_TARGET_NAME, &serialized)
}

pub fn read_local_daemon_client_identity() -> Result<Option<LocalDaemonClientIdentity>, String> {
  let Some(raw) = platform::read(LOCAL_DAEMON_CLIENT_TARGET_NAME)? else {
    return Ok(None);
  };
  parse_local_daemon_client_identity(&raw).map(Some)
}

pub fn clear_local_daemon_client_identity() -> Result<(), String> {
  platform::clear(LOCAL_DAEMON_CLIENT_TARGET_NAME)
}
