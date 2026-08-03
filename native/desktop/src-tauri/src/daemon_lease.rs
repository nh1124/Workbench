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

/// Gives up this app's lease.
///
/// Best effort by design: this runs while the app is exiting, and a daemon that has already
/// gone away, or one that expired the lease first, must not hold up the shutdown. The TTL
/// covers whatever this misses.
pub fn release(app: &AppHandle) {
  stop_heartbeat();
  let path = format!("/leases/{}", urlencode(&client_id(app)));
  if let Err(error) = crate::commands::daemon_lease_request(app, "DELETE", &path, None) {
    eprintln!("[workbench-native] could not release the sync daemon lease: {error}");
  }
}

/// Starts refreshing the lease in the background.
///
/// The refresh has to keep running for as long as the app does, and it cannot block the main
/// thread, so it lives on its own thread with a channel for the stop signal — `recv_timeout`
/// both paces the loop and wakes immediately when the app is on its way out.
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

  std::thread::spawn(move || loop {
    match receiver.recv_timeout(HEARTBEAT_INTERVAL) {
      Ok(()) | Err(RecvTimeoutError::Disconnected) => return,
      Err(RecvTimeoutError::Timeout) => {
        if let Err(error) = acquire(&app) {
          // Losing a beat is not fatal: the next one re-registers, and the daemon only drops
          // the lease after the TTL.
          eprintln!("[workbench-native] sync daemon heartbeat failed: {error}");
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
