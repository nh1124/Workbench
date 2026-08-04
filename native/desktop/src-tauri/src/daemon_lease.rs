//! This app's lease on the shared sync daemon.
//!
//! The daemon serves every Workbench app on the machine. Before leases, whichever app
//! spawned it owned it and killed it on exit, which meant quitting one window could take the
//! daemon away from another app that was still open. An app now says "I am using this" and
//! "I am done", and the daemon decides its own fate from the set of holders.
//!
//! Nothing here kills anything. That is the point.

use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::Duration;

use tauri::AppHandle;

/// Matches `LEASE_HEARTBEAT_MS` in `native/sync-daemon/src/leases.ts`, comfortably inside
/// the daemon's TTL so one missed beat does not drop the lease.
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);

/// Sends the stop signal to the heartbeat thread. `None` until a lease is taken.
fn heartbeat_stopper() -> &'static Mutex<Option<Sender<()>>> {
  static STOPPER: std::sync::OnceLock<Mutex<Option<Sender<()>>>> = std::sync::OnceLock::new();
  STOPPER.get_or_init(|| Mutex::new(None))
}

/// Identifies this app instance to the daemon.
///
/// The pid keeps two windows of the same variant apart, and makes a lease left behind by a
/// crashed app impossible to confuse with the one its replacement takes.
pub fn client_id(app: &AppHandle) -> String {
  format!("{}-{}", crate::variant::current(app).name(), std::process::id())
}

/// Takes or refreshes this app's lease. Safe to call repeatedly; the daemon upserts.
pub fn acquire(app: &AppHandle) -> Result<(), String> {
  let payload = serde_json::json!({
    "clientId": client_id(app),
    "variant": crate::variant::current(app).name(),
    "pid": std::process::id()
  })
  .to_string();
  crate::commands::daemon_lease_request(app, "POST", "/leases", Some(&payload))?;
  Ok(())
}

/// Drops this app's lease, without touching the heartbeat.
///
/// Best effort by design: a daemon that has already gone away, or one that expired the lease
/// first, must not hold anything up. The TTL covers whatever this misses.
fn release_request(app: &AppHandle) {
  let path = format!("/leases/{}", urlencode(&client_id(app)));
  if let Err(error) = crate::commands::daemon_lease_request(app, "DELETE", &path, None) {
    crate::applog::write(app, "daemon", &format!("could not release the lease: {error}"));
  }
}

/// Gives up this app's lease for good. Called while the app is exiting.
pub fn release(app: &AppHandle) {
  stop_heartbeat();
  release_request(app);
}

/// Whether this app still has a window open.
///
/// This is what "using the daemon" means. It used to be taken for granted that a live
/// process had a window — closing the last one exits the app — and that is how it behaves
/// nearly always. Nearly is not enough: Tauri only decides to exit when a window's
/// `Destroyed` event finds the registry empty (`tauri-runtime-wry`), and a process that
/// loses its windows any other way stays alive. One was found doing exactly that, still
/// beating a lease, which with `exitWhenIdle` on means the daemon can never go idle.
fn has_windows(app: &AppHandle) -> bool {
  use tauri::Manager;
  !app.webview_windows().is_empty()
}

/// Keeps the lease in step with whether this app has any windows.
///
/// Both directions matter. A windowless app must let go, and one that opens a window again
/// must take the lease back — which is why this keeps beating either way rather than
/// stopping the first time it finds nothing open.
pub fn start_heartbeat(app: AppHandle) {
  let (sender, receiver) = mpsc::channel::<()>();
  {
    let mut stopper = match heartbeat_stopper().lock() {
      Ok(stopper) => stopper,
      Err(_) => return,
    };
    if stopper.is_some() {
      return; // Already beating.
    }
    *stopper = Some(sender);
  }

  std::thread::spawn(move || {
    let mut holding = true;
    loop {
      match receiver.recv_timeout(HEARTBEAT_INTERVAL) {
        Ok(()) | Err(RecvTimeoutError::Disconnected) => return,
        Err(RecvTimeoutError::Timeout) => {
          if has_windows(&app) {
            if let Err(error) = acquire(&app) {
              // Losing a beat is not fatal: the next one re-registers, and the daemon only
              // drops the lease after the TTL.
              crate::applog::write(&app, "daemon", &format!("heartbeat failed: {error}"));
            }
            holding = true;
          } else if holding {
            // Worth saying out loud: a process with no windows that is still running is not
            // a state this app is supposed to reach, and the next time it happens this line
            // is what says so.
            crate::applog::write(
              &app,
              "daemon",
              "no windows are open; releasing the lease and staying quiet",
            );
            release_request(&app);
            holding = false;
          }
        }
      }
    }
  });
}

fn stop_heartbeat() {
  if let Ok(mut stopper) = heartbeat_stopper().lock() {
    if let Some(sender) = stopper.take() {
      let _ = sender.send(());
    }
  }
}

/// Percent-encodes the few characters a client id could contain that a path must not carry.
fn urlencode(value: &str) -> String {
  let mut encoded = String::with_capacity(value.len());
  for byte in value.bytes() {
    match byte {
      b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
        encoded.push(byte as char)
      }
      _ => encoded.push_str(&format!("%{byte:02X}")),
    }
  }
  encoded
}

#[cfg(test)]
mod tests {
  use super::urlencode;

  #[test]
  fn encodes_only_what_a_path_cannot_carry() {
    assert_eq!(urlencode("tasks-1234"), "tasks-1234");
    assert_eq!(urlencode("notes 1/2"), "notes%201%2F2");
  }
}
