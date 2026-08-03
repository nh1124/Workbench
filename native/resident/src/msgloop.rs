//! The win32 message loop the tray and the global shortcuts need.
//!
//! Both `tray-icon` and `global-hotkey` require a running win32 message loop on the thread
//! that created them, so the resident's main thread is that loop and nothing else. There is
//! no window: a thread message queue is enough, which is why every wake-up here arrives with
//! a null `hwnd` and is handled before `DispatchMessageW` throws it away.

#[cfg(windows)]
use std::sync::atomic::{AtomicU32, Ordering};

/// Posted when something has been put in the action queue.
#[cfg(windows)]
const WM_APP_ACTION: u32 = 0x8000 + 1;
/// Posted when the stored shortcuts changed on disk.
#[cfg(windows)]
const WM_APP_RELOAD_SHORTCUTS: u32 = 0x8000 + 2;

/// Thread that owns the loop. Zero until [`run`] starts, which is why [`wake`] is a no-op
/// before then — actions queued that early are drained by the first pass anyway.
#[cfg(windows)]
static LOOP_THREAD_ID: AtomicU32 = AtomicU32::new(0);

#[cfg(windows)]
fn post_to_loop(message: u32) {
  use windows_sys::Win32::UI::WindowsAndMessaging::PostThreadMessageW;

  let thread_id = LOOP_THREAD_ID.load(Ordering::SeqCst);
  if thread_id == 0 {
    return;
  }
  unsafe {
    PostThreadMessageW(thread_id, message, 0, 0);
  }
}

/// Wakes the loop to drain the action queue.
#[cfg(windows)]
pub fn wake() {
  post_to_loop(WM_APP_ACTION);
}

/// Tells the loop the stored shortcuts changed.
#[cfg(windows)]
pub fn request_shortcut_reload() {
  post_to_loop(WM_APP_RELOAD_SHORTCUTS);
}

/// What the loop should do when it wakes.
pub trait LoopHandler {
  /// Runs everything queued. Returns `false` to end the loop.
  fn handle_actions(&mut self) -> bool;
  /// Re-reads the stored shortcuts and re-registers them.
  fn reload_shortcuts(&mut self);
}

/// Runs until a handler asks to stop.
#[cfg(windows)]
pub fn run<H: LoopHandler>(handler: &mut H) {
  use windows_sys::Win32::System::Threading::GetCurrentThreadId;
  use windows_sys::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, GetMessageW, TranslateMessage, MSG,
  };

  LOOP_THREAD_ID.store(unsafe { GetCurrentThreadId() }, Ordering::SeqCst);
  // Anything queued while the thread id was still zero got no wake-up, so start by draining.
  if !handler.handle_actions() {
    return;
  }

  let mut message: MSG = unsafe { std::mem::zeroed() };
  loop {
    // -1 is an error and 0 is WM_QUIT; both end the loop. Looping on an error would spin.
    let result = unsafe { GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) };
    if result <= 0 {
      return;
    }

    if message.hwnd.is_null() {
      match message.message {
        WM_APP_ACTION => {
          if !handler.handle_actions() {
            return;
          }
          continue;
        }
        WM_APP_RELOAD_SHORTCUTS => {
          handler.reload_shortcuts();
          continue;
        }
        _ => {}
      }
    }

    unsafe {
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }
  }
}

#[cfg(not(windows))]
pub fn wake() {}

#[cfg(not(windows))]
pub fn request_shortcut_reload() {}

#[cfg(not(windows))]
pub fn run<H: LoopHandler>(_handler: &mut H) {}
