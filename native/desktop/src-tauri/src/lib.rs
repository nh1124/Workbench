use tauri::{WebviewUrl, WebviewWindowBuilder};
#[cfg(desktop)]
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(desktop)]
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(desktop)]
static MAIN_WINDOW_COUNTER: AtomicU64 = AtomicU64::new(1);
#[cfg(desktop)]
static QUICK_NOTE_WINDOW_COUNTER: AtomicU64 = AtomicU64::new(1);

#[cfg(target_os = "windows")]
mod secure_storage {
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
mod secure_storage {
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

#[tauri::command]
fn secure_session_save(session_json: String) -> Result<(), String> {
  secure_storage::save(&session_json)
}

#[tauri::command]
fn secure_session_read() -> Result<Option<String>, String> {
  secure_storage::read()
}

#[tauri::command]
fn secure_session_clear() -> Result<(), String> {
  secure_storage::clear()
}

#[cfg(desktop)]
fn build_main_window_label() -> String {
  let ts = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|value| value.as_millis())
    .unwrap_or(0);
  let seq = MAIN_WINDOW_COUNTER.fetch_add(1, Ordering::Relaxed);
  format!("main-{ts}-{seq}")
}

#[cfg(desktop)]
fn open_new_main_window(app: &tauri::AppHandle) -> Result<(), String> {
  let window_label = build_main_window_label();
  WebviewWindowBuilder::new(app, window_label, WebviewUrl::App("index.html".into()))
    .title("Workbench")
    .inner_size(1280.0, 860.0)
    .resizable(true)
    .focused(true)
    .disable_drag_drop_handler()
    .build()
    .and_then(|window| {
      let _ = window.unminimize();
      let _ = window.show();
      let _ = window.set_focus();
      Ok(())
    })
    .map_err(|error| format!("failed to open main window: {error}"))
}

#[cfg(not(desktop))]
fn open_new_main_window(_app: &tauri::AppHandle) -> Result<(), String> {
  Err("main window duplication is not supported on this platform".to_string())
}

#[cfg(desktop)]
fn should_open_new_main_window(argv: &[String]) -> bool {
  !argv
    .iter()
    .map(|arg| arg.to_ascii_lowercase())
    .any(|arg| arg.contains("quick-note-window=1"))
}

#[cfg(desktop)]
fn build_quick_note_window_label() -> String {
  let ts = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|value| value.as_millis())
    .unwrap_or(0);
  let seq = QUICK_NOTE_WINDOW_COUNTER.fetch_add(1, Ordering::Relaxed);
  format!("quick-note-{ts}-{seq}")
}

#[cfg(desktop)]
fn open_new_quick_note_window(app: &tauri::AppHandle) -> Result<(), String> {
  let window_label = build_quick_note_window_label();
  WebviewWindowBuilder::new(
    app,
    window_label,
    WebviewUrl::App("index.html?quick-note-window=1".into()),
  )
  .title("Quick Note")
  .inner_size(560.0, 760.0)
  .resizable(true)
  .focused(true)
  .disable_drag_drop_handler()
  .build()
  .and_then(|window| {
    window.set_always_on_top(true)?;
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    Ok(())
  })
  .map_err(|error| format!("failed to open quick note window: {error}"))
}

#[cfg(not(desktop))]
fn open_new_quick_note_window(_app: &tauri::AppHandle) -> Result<(), String> {
  Err("quick note window is not supported on this platform".to_string())
}

#[tauri::command]
fn open_quick_note_window(app: tauri::AppHandle) -> Result<(), String> {
  open_new_quick_note_window(&app)
}

#[tauri::command]
fn close_quick_note_window(window: tauri::WebviewWindow) -> Result<(), String> {
  window
    .close()
    .map_err(|error| format!("failed to close quick note window: {error}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
      #[cfg(desktop)]
      {
        if should_open_new_main_window(&argv) {
          if let Err(error) = open_new_main_window(app) {
            eprintln!("[workbench-native] failed to open window for second instance: {error}");
          }
        }
      }
    }))
    .setup(|app| {
      #[cfg(desktop)]
      {
        // Close any windows created from tauri.conf.json (they lack disable_drag_drop_handler).
        // We recreate the main window here so drag-and-drop works correctly in the WebView.
        use tauri::Manager;
        for window in app.webview_windows().values() {
          let _ = window.close();
        }
        open_new_main_window(app.handle()).map_err(|e| Box::<dyn std::error::Error>::from(e))?;
      }
      #[cfg(desktop)]
      {
        use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

        let win_alt_n = Shortcut::new(Some(Modifiers::SUPER | Modifiers::ALT), Code::KeyN);
        let ctrl_alt_n = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyN);
        let win_alt_n_handler = win_alt_n.clone();
        let ctrl_alt_n_handler = ctrl_alt_n.clone();

        let plugin_result = app.handle().plugin(
          tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, shortcut, event| {
              if event.state() != ShortcutState::Pressed {
                return;
              }
              if shortcut == &win_alt_n_handler || shortcut == &ctrl_alt_n_handler {
                let _ = open_new_quick_note_window(app);
              }
            })
            .build(),
        );

        if let Err(error) = plugin_result {
          eprintln!("[workbench-native] global shortcut plugin setup failed: {error}");
        } else {
          if let Err(error) = app.global_shortcut().register(win_alt_n) {
            eprintln!("[workbench-native] failed to register hotkey ALT+SUPER+N: {error}");
          }
          if let Err(error) = app.global_shortcut().register(ctrl_alt_n) {
            eprintln!("[workbench-native] failed to register hotkey CTRL+ALT+N: {error}");
          }
        }
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      secure_session_save,
      secure_session_read,
      secure_session_clear,
      open_quick_note_window,
      close_quick_note_window
    ])
    .run(tauri::generate_context!())
    .expect("error while running workbench native application");
}
