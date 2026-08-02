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
static APP_WINDOW_COUNTER: AtomicU64 = AtomicU64::new(1);

#[cfg(desktop)]
fn is_main_window_label(label: &str) -> bool {
  label.starts_with("main-")
}

/// Applies the storage and variant identity shared by every window in this process.
///
/// This must be applied to **every** window this module builds. Tauri keys its
/// `WebContext` on the data directory, so a window left on the default would get a
/// separate localStorage from its siblings. A window without the initialization script
/// has no variant identity and would fall back to the main app UI.
fn with_window_defaults<'a, R, M>(
  builder: WebviewWindowBuilder<'a, R, M>,
  variant: crate::variant::AppVariant,
) -> WebviewWindowBuilder<'a, R, M>
where
  R: tauri::Runtime,
  M: tauri::Manager<R>,
{
  let builder = match crate::variant::shared_webview_data_directory() {
    Some(path) => builder.data_directory(path),
    None => builder,
  };
  builder.initialization_script(crate::variant::initialization_script(variant))
}

/// Builds a window, recording how far it got.
///
/// This used to hand the work to `run_on_main_thread` first. The app log showed that was
/// wrong: "building ... on the main thread" with no "built" after it. Creating a webview
/// needs the event loop to keep turning — WebView2 finishes initialising through it — so a
/// callback that builds from inside the loop is blocking the very thing it waits on.
///
/// The global-shortcut path never took that detour and has always worked, so this calls the
/// builder the same way it does.
pub fn build_logged<F>(app: &tauri::AppHandle, what: &str, build: F) -> Result<(), String>
where
  F: FnOnce(&tauri::AppHandle) -> Result<(), String>,
{
  crate::applog::write(app, "window", &format!("building {what}"));
  // The custom title bar's window procedure must keep its hands off Tauri until this
  // returns, or it deadlocks the very build it is running alongside.
  crate::titlebar::begin_window_build();
  let result = build(app);
  crate::titlebar::end_window_build();
  match &result {
    Ok(()) => crate::applog::write(app, "window", &format!("{what} built")),
    Err(error) => crate::applog::write(app, "window", &format!("failed to open {what}: {error}")),
  }
  result
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
    let variant = crate::variant::current(app);
    let is_main_variant = variant.is_main();
    let window_label = build_main_window_label();
    with_window_defaults(
      WebviewWindowBuilder::new(
        app,
        window_label,
        WebviewUrl::App("index.html".into()),
      ),
      variant,
    )
      .title(variant.window_title())
      .inner_size(1280.0, 860.0)
      .resizable(true)
      .focused(true)
      // Dedicated apps draw their own title bar so the account control can live in the
      // window frame. Main keeps the native one.
      .decorations(is_main_variant)
      .disable_drag_drop_handler()
      .build()
      .and_then(|window| {
        if !is_main_variant {
          // Undecorated windows get no native maximize button, so Windows would never
          // offer Snap Layouts without this.
          if let Err(error) = crate::titlebar::install(&window) {
            eprintln!("[workbench-native] snap layout support unavailable: {error}");
          }
        }
        #[cfg(target_os = "windows")]
        let tracked_hwnd = window.hwnd().ok().map(|handle| handle.0 as isize);
        let event_window = window.clone();
        window.on_window_event(move |event| {
          #[cfg(target_os = "windows")]
          if matches!(event, WindowEvent::Destroyed) {
            if let Some(hwnd) = tracked_hwnd {
              crate::titlebar::forget_window(hwnd);
            }
          }
          if let WindowEvent::CloseRequested { api, .. } = event {
            // Keep exactly one resident main window alive.
            // If this is the last main window, hide it instead of closing.
            if !is_main_variant {
              return;
            }
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

/// Opens another window of a dedicated app at `query`, e.g. `?note=<id>`.
///
/// This goes through the same path as the app's own window — undecorated, shared WebView2
/// data directory, snap-layout hit testing — rather than the generic app-window command,
/// which produces a decorated window that does not carry any of that setup.
pub fn open_variant_window(app: &tauri::AppHandle, query: &str) -> Result<(), String> {
  #[cfg(desktop)]
  {
    if !query.is_empty() && !query.starts_with('?') {
      return Err("variant window query must be empty or start with ?".to_string());
    }

    let variant = crate::variant::current(app);
    let app_url = if query.is_empty() { "index.html" } else { query };
    let window_label = build_main_window_label();
    with_window_defaults(
      WebviewWindowBuilder::new(app, window_label, WebviewUrl::App(app_url.into())),
      variant,
    )
    .title(variant.window_title())
    .inner_size(760.0, 820.0)
    .resizable(true)
    .focused(true)
    .decorations(false)
    .disable_drag_drop_handler()
    .build()
    .and_then(|window| {
      if let Err(error) = crate::titlebar::install(&window) {
        eprintln!("[workbench-native] snap layout support unavailable: {error}");
      }
      let _ = window.unminimize();
      let _ = window.show();
      let _ = window.set_focus();
      Ok(())
    })
    .map_err(|error| format!("failed to open variant window: {error}"))
  }
  #[cfg(not(desktop))]
  {
    let _ = (app, query);
    Err("variant windows are not supported on this platform".to_string())
  }
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

#[cfg(desktop)]
fn build_app_window_label() -> String {
  let ts = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|value| value.as_millis())
    .unwrap_or(0);
  let seq = APP_WINDOW_COUNTER.fetch_add(1, Ordering::Relaxed);
  format!("artifact-{ts}-{seq}")
}

#[cfg(desktop)]
fn validate_app_window_url(current_url: &tauri::Url, requested_url: &str) -> Result<tauri::Url, String> {
  let trimmed = requested_url.trim();
  if trimmed.is_empty() {
    return Err("app window URL is required".to_string());
  }

  let target_url = current_url
    .join(trimmed)
    .map_err(|error| format!("invalid app window URL: {error}"))?;
  if target_url.origin() != current_url.origin() {
    return Err("app window URL must stay within the current Workbench UI origin".to_string());
  }

  Ok(target_url)
}

/// Opens a new quick-note window (small, always-on-top).
///
/// On non-desktop platforms this is a no-op that returns an error.
pub fn open_new_quick_note_window(app: &tauri::AppHandle) -> Result<(), String> {
  #[cfg(desktop)]
  {
    let window_label = build_quick_note_window_label();
    with_window_defaults(
      WebviewWindowBuilder::new(
        app,
        window_label,
        WebviewUrl::App("index.html".into()),
      ),
      crate::variant::current(app),
    )
    // Which window this is arrives the same way the variant does. It used to ride in the
    // URL, which left this the one window loading /index.html rather than the site root.
    .initialization_script("window.__WORKBENCH_QUICK_NOTE__ = true;")
    .title("Quick Note")
    .inner_size(560.0, 760.0)
    .resizable(true)
    .focused(true)
    .disable_drag_drop_handler()
    .build()
    .and_then(|window| {
      // Step by step: "building" with no "built" says only that this whole block did not
      // finish, which is true whether the builder blocked or one of these calls did.
      crate::applog::write(app, "window", "quick note: builder returned");
      window.set_always_on_top(true)?;
      crate::applog::write(app, "window", "quick note: always-on-top set");
      let _ = window.unminimize();
      let _ = window.show();
      crate::applog::write(app, "window", "quick note: shown");
      let _ = window.set_focus();
      crate::applog::write(app, "window", "quick note: focused");
      Ok(())
    })
    .map_err(|error| format!("failed to open quick note window: {error}"))
  }
  #[cfg(not(desktop))]
  Err("quick note window is not supported on this platform".to_string())
}

/// Opens or focuses the dedicated calendar window at a Workbench-local URL.
pub fn open_calendar_window(app: &tauri::AppHandle, url: &str) -> Result<(), String> {
  #[cfg(desktop)]
  {
    let current_url = app
      .webview_windows()
      .values()
      .next()
      .ok_or_else(|| "no Workbench window is available".to_string())?
      .url()
      .map_err(|error| format!("failed to read current app window URL: {error}"))?;
    let target_url = validate_app_window_url(&current_url, url)?;

    if let Some(calendar_window) = app.get_webview_window("calendar") {
      calendar_window
        .navigate(target_url)
        .map_err(|error| format!("failed to navigate calendar window: {error}"))?;
      let _ = calendar_window.unminimize();
      let _ = calendar_window.show();
      let _ = calendar_window.set_focus();
      return Ok(());
    }

    let webview_url = match target_url.scheme() {
      "http" | "https" => WebviewUrl::External(target_url),
      _ => WebviewUrl::CustomProtocol(target_url),
    };
    with_window_defaults(
      WebviewWindowBuilder::new(app, "calendar", webview_url),
      crate::variant::current(app),
    )
      .title("Workbench Calendar")
      .inner_size(1100.0, 800.0)
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
      .map_err(|error| format!("failed to open calendar window: {error}"))
  }
  #[cfg(not(desktop))]
  Err("calendar window is not supported on this platform".to_string())
}

/// Opens a new app window at a URL within the current Workbench UI origin.
///
/// This accepts relative app paths from the frontend and rejects any URL that
/// resolves outside the origin of the invoking window.
pub fn open_new_app_window(
  app: &tauri::AppHandle,
  current_window: &tauri::WebviewWindow,
  url: &str,
) -> Result<(), String> {
  #[cfg(desktop)]
  {
    let current_url = current_window
      .url()
      .map_err(|error| format!("failed to read current app window URL: {error}"))?;
    let target_url = validate_app_window_url(&current_url, url)?;
    let webview_url = match target_url.scheme() {
      "http" | "https" => WebviewUrl::External(target_url),
      _ => WebviewUrl::CustomProtocol(target_url),
    };

    with_window_defaults(
      WebviewWindowBuilder::new(app, build_app_window_label(), webview_url),
      crate::variant::current(app),
    )
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
      .map_err(|error| format!("failed to open app window: {error}"))
  }
  #[cfg(not(desktop))]
  Err("app window opening is not supported on this platform".to_string())
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
