//! Everything the Workbench desktop apps and the resident must agree on exactly.
//!
//! The resident owns the sync daemon: it starts it at login and keeps it alive. The apps
//! still have to reach the same daemon, read the same settings, and — when the resident is
//! not running — be able to start it themselves. Two implementations of "which sync root",
//! "which account", or "is something already on the port" would drift, and the failure would
//! be a daemon quietly syncing the wrong folder rather than anything that looks like a bug.
//!
//! So this crate holds one copy, and nothing in it depends on Tauri. The apps wrap these in
//! `#[tauri::command]`; the resident calls them directly.

pub mod account;
pub mod daemon;
pub mod launch_guard;
pub mod log;
pub mod loopback;
pub mod paths;
pub mod preferences;
pub mod resident;
pub mod secure_storage;
pub mod shortcuts;
