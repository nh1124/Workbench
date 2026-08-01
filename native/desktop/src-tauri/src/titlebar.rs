//! Win11 Snap Layouts support for the dedicated apps' custom title bar.
//!
//! An undecorated window has no native maximize button, so Windows never offers the snap
//! layout flyout. Windows keys that behaviour off the hit-test result: it shows the flyout
//! when `WM_NCHITTEST` reports `HTMAXBUTTON`. We therefore subclass the window and answer
//! `HTMAXBUTTON` while the cursor is over the maximize button the webview drew.
//!
//! Returning `HTMAXBUTTON` also means the webview stops receiving mouse input there, so the
//! button would never light up on hover and clicks would never reach it. Both are handled
//! here: hover state is pushed into the page, and the non-client click messages are turned
//! back into a maximize toggle.

#[cfg(target_os = "windows")]
mod platform {
  use std::collections::HashMap;
  use std::sync::{Mutex, OnceLock};

  use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
  use windows_sys::Win32::Graphics::Gdi::ScreenToClient;
  use windows_sys::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
  use windows_sys::Win32::UI::WindowsAndMessaging::{
    HTCLIENT, HTMAXBUTTON, WM_NCLBUTTONDOWN, WM_NCLBUTTONUP, WM_NCMOUSELEAVE, WM_NCMOUSEMOVE,
    WM_NCHITTEST,
  };

  const SUBCLASS_ID: usize = 0x7762_0001;

  /// Maximize button rectangle in physical pixels, relative to the window's client area.
  #[derive(Clone, Copy, Default)]
  struct ButtonRect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
  }

  impl ButtonRect {
    fn contains(&self, x: i32, y: i32) -> bool {
      // An empty rect must never match, otherwise a window whose rect has not been
      // reported yet would swallow clicks at the client origin.
      self.right > self.left && self.bottom > self.top && x >= self.left && x < self.right && y >= self.top && y < self.bottom
    }
  }

  fn button_rects() -> &'static Mutex<HashMap<isize, ButtonRect>> {
    static RECTS: OnceLock<Mutex<HashMap<isize, ButtonRect>>> = OnceLock::new();
    RECTS.get_or_init(|| Mutex::new(HashMap::new()))
  }

  fn rect_for(hwnd: HWND) -> Option<ButtonRect> {
    button_rects().lock().ok()?.get(&(hwnd as isize)).copied()
  }

  pub fn store_rect(hwnd: isize, left: i32, top: i32, right: i32, bottom: i32) {
    if let Ok(mut rects) = button_rects().lock() {
      rects.insert(
        hwnd,
        ButtonRect {
          left,
          top,
          right,
          bottom,
        },
      );
    }
  }

  pub fn forget(hwnd: isize) {
    if let Ok(mut rects) = button_rects().lock() {
      rects.remove(&hwnd);
    }
  }

  /// Screen coordinates ride in `lParam` for the non-client messages we care about.
  fn client_point(hwnd: HWND, lparam: LPARAM) -> Option<(i32, i32)> {
    let mut point = POINT {
      x: (lparam & 0xFFFF) as i16 as i32,
      y: ((lparam >> 16) & 0xFFFF) as i16 as i32,
    };
    let ok = unsafe { ScreenToClient(hwnd, &mut point) };
    if ok == 0 {
      return None;
    }
    Some((point.x, point.y))
  }

  fn over_maximize_button(hwnd: HWND, lparam: LPARAM) -> bool {
    let Some(rect) = rect_for(hwnd) else {
      return false;
    };
    let Some((x, y)) = client_point(hwnd, lparam) else {
      return false;
    };
    rect.contains(x, y)
  }

  unsafe extern "system" fn subclass_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _data: usize,
  ) -> LRESULT {
    match message {
      WM_NCHITTEST => {
        let hit = unsafe { DefSubclassProc(hwnd, message, wparam, lparam) };
        // Only claim the button while the default handling says we are over page content;
        // the real frame edges must keep their resize hit codes.
        if hit == HTCLIENT as LRESULT && over_maximize_button(hwnd, lparam) {
          return HTMAXBUTTON as LRESULT;
        }
        hit
      }
      // Windows sends these instead of the client-area equivalents once we claim the
      // button, so the click has to be turned back into an action by hand.
      WM_NCLBUTTONDOWN if wparam == HTMAXBUTTON as WPARAM => 0,
      WM_NCLBUTTONUP if wparam == HTMAXBUTTON as WPARAM => {
        set_hover(hwnd, false);
        toggle_maximize(hwnd);
        0
      }
      WM_NCMOUSEMOVE => {
        set_hover(hwnd, wparam == HTMAXBUTTON as WPARAM);
        unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
      }
      WM_NCMOUSELEAVE => {
        set_hover(hwnd, false);
        unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
      }
      _ => unsafe { DefSubclassProc(hwnd, message, wparam, lparam) },
    }
  }

  /// Windows owns the pointer while it is over the button, so the page cannot know it is
  /// hovered. Push the state in rather than leaving the button visually dead.
  ///
  /// Only state *changes* are pushed: `WM_NCMOUSEMOVE` fires continuously.
  fn set_hover(hwnd: HWND, hovered: bool) {
    static HOVERED: OnceLock<Mutex<HashMap<isize, bool>>> = OnceLock::new();
    let states = HOVERED.get_or_init(|| Mutex::new(HashMap::new()));
    {
      let Ok(mut states) = states.lock() else {
        return;
      };
      if states.get(&(hwnd as isize)).copied().unwrap_or(false) == hovered {
        return;
      }
      states.insert(hwnd as isize, hovered);
    }

    let script = format!(
      "document.documentElement.classList.toggle('wb-maximize-hover', {hovered});"
    );
    with_window(hwnd, move |window| {
      let _ = window.eval(&script);
    });
  }

  fn toggle_maximize(hwnd: HWND) {
    with_window(hwnd, |window| match window.is_maximized() {
      Ok(true) => {
        let _ = window.unmaximize();
      }
      Ok(false) => {
        let _ = window.maximize();
      }
      Err(_) => {}
    });
  }

  /// Defers the work onto the main loop.
  ///
  /// This runs inside a window procedure, so touching Tauri here would re-enter it while it
  /// may still hold the locks guarding its window map — during window creation that
  /// deadlocks and the window never appears.
  fn with_window(hwnd: HWND, action: impl FnOnce(&tauri::WebviewWindow) + Send + 'static) {
    let Some(app) = crate::titlebar::app_handle() else {
      return;
    };
    let target = hwnd as isize;
    let _ = app.clone().run_on_main_thread(move || {
      use tauri::Manager;
      for window in app.webview_windows().values() {
        if window.hwnd().ok().map(|handle| handle.0 as isize) == Some(target) {
          action(window);
          return;
        }
      }
    });
  }

  pub fn install(window: &tauri::WebviewWindow) -> Result<(), String> {
    let hwnd = window
      .hwnd()
      .map_err(|error| format!("failed to read window handle: {error}"))?;
    let ok = unsafe { SetWindowSubclass(hwnd.0 as HWND, Some(subclass_proc), SUBCLASS_ID, 0) };
    if ok == 0 {
      return Err("failed to subclass window for snap layout support".to_string());
    }
    Ok(())
  }
}

#[cfg(target_os = "windows")]
use std::sync::OnceLock;

#[cfg(target_os = "windows")]
static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

#[cfg(target_os = "windows")]
pub(crate) fn app_handle() -> Option<tauri::AppHandle> {
  APP_HANDLE.get().cloned()
}

/// Remembers the handle the subclass callback needs; the callback is a bare `extern "system"`
/// function and cannot capture one.
#[cfg(target_os = "windows")]
pub fn remember_app_handle(app: &tauri::AppHandle) {
  let _ = APP_HANDLE.set(app.clone());
}

#[cfg(not(target_os = "windows"))]
pub fn remember_app_handle(_app: &tauri::AppHandle) {}

/// Starts answering `HTMAXBUTTON` for this window's custom maximize button.
#[cfg(target_os = "windows")]
pub fn install(window: &tauri::WebviewWindow) -> Result<(), String> {
  platform::install(window)
}

#[cfg(not(target_os = "windows"))]
pub fn install(_window: &tauri::WebviewWindow) -> Result<(), String> {
  Ok(())
}

/// Records where the webview drew the maximize button, in CSS pixels.
#[tauri::command]
pub fn set_maximize_button_rect(
  window: tauri::Window,
  x: f64,
  y: f64,
  width: f64,
  height: f64,
) -> Result<(), String> {
  #[cfg(target_os = "windows")]
  {
    let scale = window
      .scale_factor()
      .map_err(|error| format!("failed to read window scale factor: {error}"))?;
    let hwnd = window
      .hwnd()
      .map_err(|error| format!("failed to read window handle: {error}"))?;
    let left = (x * scale).round() as i32;
    let top = (y * scale).round() as i32;
    let right = ((x + width) * scale).round() as i32;
    let bottom = ((y + height) * scale).round() as i32;
    platform::store_rect(hwnd.0 as isize, left, top, right, bottom);
  }
  #[cfg(not(target_os = "windows"))]
  {
    let _ = (&window, x, y, width, height);
  }
  Ok(())
}

/// Stops claiming the button for a window that is going away.
#[cfg(target_os = "windows")]
pub fn forget_window(hwnd: isize) {
  platform::forget(hwnd);
}
