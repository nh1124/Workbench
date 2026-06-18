//! Window creation and management.
//!
//! Provides helpers for opening main and quick-note windows.
//! Each window gets a unique label derived from a timestamp and a monotonic counter
//! so that multiple instances can coexist without label collisions.
//!
//! # Taskbar shift+click (Windows)
//! When the user shift+clicks the taskbar icon, Windows launches a new process.
//! `tauri-plugin-single-instance` intercepts the second process and invokes the
//! handler registered in `lib.rs`, which calls [`open_new_main_window`].

#[cfg(desktop)]
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(desktop)]
use std::time::{SystemTime, UNIX_EPOCH};
#[cfg(desktop)]
use tauri::{Manager, WindowEvent};
use tauri::{WebviewUrl, WebviewWindowBuilder};

#[cfg(desktop)]
static MAIN_WINDOW_COUNTER: AtomicU64 = AtomicU64::new(1);
#[cfg(desktop)]
static QUICK_NOTE_WINDOW_COUNTER: AtomicU64 = AtomicU64::new(1);

#[cfg(desktop)]
fn is_main_window_label(label: &str) -> bool {
  label.starts_with("main-")
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

/// Opens a new main window.
///
/// On non-desktop platforms this is a no-op that returns an error.
pub fn open_new_main_window(app: &tauri::AppHandle) -> Result<(), String> {
  #[cfg(desktop)]
  {
    let window_label = build_main_window_label();
    WebviewWindowBuilder::new(app, window_label, WebviewUrl::App("index.html".into()))
      .title("Workbench")
      .inner_size(1280.0, 860.0)
      .resizable(true)
      .focused(true)
      .disable_drag_drop_handler()
      .build()
      .and_then(|window| {
        let event_window = window.clone();
        window.on_window_event(move |event| {
          if let WindowEvent::CloseRequested { api, .. } = event {
            // Keep exactly one resident main window alive.
            // If this is the last main window, hide it instead of closing.
            if !crate::commands::daemon_resident_mode_enabled(event_window.app_handle()) {
              return;
            }
            let main_window_count = event_window
              .app_handle()
              .webview_windows()
              .values()
              .filter(|candidate| is_main_window_label(candidate.label()))
              .count();
            if main_window_count <= 1 {
              api.prevent_close();
              let _ = event_window.hide();
            }
          }
        });
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        Ok(())
      })
      .map_err(|error| format!("failed to open main window: {error}"))
  }
  #[cfg(not(desktop))]
  Err("main window duplication is not supported on this platform".to_string())
}

/// Shows an existing main window if present; otherwise creates a new one.
///
/// This is used by tray interactions to restore the app from resident state.
pub fn show_or_create_main_window(app: &tauri::AppHandle) -> Result<(), String> {
  #[cfg(desktop)]
  {
    if let Some(main_window) = app
      .webview_windows()
      .values()
      .find(|window| is_main_window_label(window.label()))
      .cloned()
    {
      let _ = main_window.unminimize();
      let _ = main_window.show();
      let _ = main_window.set_focus();
      return Ok(());
    }
    open_new_main_window(app)
  }
  #[cfg(not(desktop))]
  Err("main window restore is not supported on this platform".to_string())
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

/// Opens a new quick-note window (small, always-on-top).
///
/// On non-desktop platforms this is a no-op that returns an error.
pub fn open_new_quick_note_window(app: &tauri::AppHandle) -> Result<(), String> {
  #[cfg(desktop)]
  {
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
  Err("quick note window is not supported on this platform".to_string())
}

/// Returns `true` when the CLI arguments indicate that a new **main** window
/// should be opened (i.e. the launch is not for a quick-note window).
///
/// Used by the `single-instance` plugin handler to decide what to do when a
/// second process is started (e.g. via taskbar shift+click).
#[cfg(desktop)]
pub fn should_open_new_main_window(argv: &[String]) -> bool {
  !argv
    .iter()
    .map(|arg| arg.to_ascii_lowercase())
    .any(|arg| arg.contains("quick-note-window=1"))
}
