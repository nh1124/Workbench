//! The tray icon: the only thing on screen when no Workbench window is open.
//!
//! This is what makes the resident visible. Without it a process that owns the daemon and
//! the global shortcuts would be running with nothing to show for it and no way to stop it
//! short of Task Manager.

use tray_icon::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder, TrayIconEvent};

use crate::action::{self, Action};
use crate::apps::App;

const MENU_OPEN_MAIN: &str = "open-main";
const MENU_OPEN_TASKS: &str = "open-tasks";
const MENU_OPEN_NOTES: &str = "open-notes";
const MENU_OPEN_ARTIFACTS: &str = "open-artifacts";
const MENU_QUICK_NOTE: &str = "quick-note";
const MENU_DAEMON_LOG: &str = "daemon-log";
const MENU_APP_LOG: &str = "app-log";
const MENU_RESTART_DAEMON: &str = "restart-daemon";
const MENU_AUTOSTART: &str = "autostart";
const MENU_QUIT: &str = "quit";

/// Ordinal of the icon in this executable's resources; see `resident.rc`.
#[cfg(windows)]
const ICON_ORDINAL: u16 = 1;

fn menu_action(id: &str) -> Option<Action> {
  match id {
    MENU_OPEN_MAIN => Some(Action::Open(App::Main)),
    MENU_OPEN_TASKS => Some(Action::Open(App::Tasks)),
    MENU_OPEN_NOTES => Some(Action::Open(App::Notes)),
    MENU_OPEN_ARTIFACTS => Some(Action::Open(App::Artifacts)),
    MENU_QUICK_NOTE => Some(Action::QuickNote),
    MENU_DAEMON_LOG => Some(Action::OpenDaemonLog),
    MENU_APP_LOG => Some(Action::OpenAppLog),
    MENU_RESTART_DAEMON => Some(Action::RestartDaemon),
    MENU_AUTOSTART => Some(Action::ToggleAutostart),
    MENU_QUIT => Some(Action::Quit),
    _ => None,
  }
}

#[cfg(windows)]
fn load_icon() -> Result<Icon, String> {
  Icon::from_resource(ICON_ORDINAL, None)
    .map_err(|error| format!("failed to load the embedded tray icon: {error}"))
}

#[cfg(not(windows))]
fn load_icon() -> Result<Icon, String> {
  Err("the resident tray icon is embedded as a Windows resource".to_string())
}

pub struct Tray {
  // Dropping a `TrayIcon` removes it from the notification area, so this is held for as long
  // as the resident runs even though nothing reads it after construction.
  _icon: TrayIcon,
  autostart_item: CheckMenuItem,
}

impl Tray {
  pub fn new() -> Result<Self, String> {
    let open_main = MenuItem::with_id(MENU_OPEN_MAIN, "Open Workbench", true, None);
    let open_tasks = MenuItem::with_id(MENU_OPEN_TASKS, "Tasks", true, None);
    let open_notes = MenuItem::with_id(MENU_OPEN_NOTES, "Notes", true, None);
    let open_artifacts = MenuItem::with_id(MENU_OPEN_ARTIFACTS, "Artifacts", true, None);
    let quick_note = MenuItem::with_id(MENU_QUICK_NOTE, "New quick note", true, None);
    let restart_daemon = MenuItem::with_id(MENU_RESTART_DAEMON, "Restart syncing", true, None);
    // The sync daemon has no console, and release builds of the apps have none either, so
    // these two files are the only account of what happened.
    let daemon_log = MenuItem::with_id(MENU_DAEMON_LOG, "Open sync daemon log", true, None);
    let app_log = MenuItem::with_id(MENU_APP_LOG, "Open app log", true, None);
    let autostart_item = CheckMenuItem::with_id(
      MENU_AUTOSTART,
      "Start Workbench at login",
      true,
      crate::autostart::is_enabled(),
      None,
    );
    let quit = MenuItem::with_id(
      MENU_QUIT,
      "Quit Workbench (closes apps, stops syncing)",
      true,
      None,
    );

    let menu = Menu::new();
    menu
      .append_items(&[
        &open_main,
        &open_tasks,
        &open_notes,
        &open_artifacts,
        &PredefinedMenuItem::separator(),
        &quick_note,
        &PredefinedMenuItem::separator(),
        &restart_daemon,
        &daemon_log,
        &app_log,
        &PredefinedMenuItem::separator(),
        &autostart_item,
        &quit,
      ])
      .map_err(|error| format!("failed to build the tray menu: {error}"))?;

    MenuEvent::set_event_handler(Some(|event: MenuEvent| {
      match menu_action(event.id().as_ref()) {
        Some(action) => action::post(action),
        None => workbench_shared::log::write(
          "tray",
          &format!("menu item {} has no action", event.id().as_ref()),
        ),
      }
    }));

    TrayIconEvent::set_event_handler(Some(|event: TrayIconEvent| {
      // Left-click opens the app; right-click is the menu, which tray-icon handles itself.
      if let TrayIconEvent::Click {
        button: tray_icon::MouseButton::Left,
        button_state: tray_icon::MouseButtonState::Up,
        ..
      } = event
      {
        action::post(Action::Open(App::Main));
      }
    }));

    let icon = TrayIconBuilder::new()
      .with_id("workbench-resident")
      .with_icon(load_icon()?)
      .with_tooltip("Workbench")
      .with_menu(Box::new(menu))
      .with_menu_on_left_click(false)
      .build()
      .map_err(|error| format!("failed to create the tray icon: {error}"))?;

    Ok(Self {
      _icon: icon,
      autostart_item,
    })
  }

  /// Re-reads whether start-at-login is on and ticks the menu to match.
  ///
  /// Read back rather than assumed, so a write that failed shows as an unticked box instead
  /// of a tick that claims something untrue.
  pub fn refresh_autostart_state(&self) {
    self
      .autostart_item
      .set_checked(crate::autostart::is_enabled());
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn every_menu_id_resolves_to_an_action() {
    for id in [
      MENU_OPEN_MAIN,
      MENU_OPEN_TASKS,
      MENU_OPEN_NOTES,
      MENU_OPEN_ARTIFACTS,
      MENU_QUICK_NOTE,
      MENU_DAEMON_LOG,
      MENU_APP_LOG,
      MENU_RESTART_DAEMON,
      MENU_AUTOSTART,
      MENU_QUIT,
    ] {
      assert!(menu_action(id).is_some(), "{id} has no action");
    }
  }

  #[test]
  fn a_separator_click_is_not_mistaken_for_an_item() {
    // Predefined items carry generated ids, and treating an unknown id as an action would
    // make the wrong menu entry fire.
    assert_eq!(menu_action("4294967295"), None);
    assert_eq!(menu_action(""), None);
  }

  #[test]
  fn the_menu_ids_are_distinct() {
    let ids = [
      MENU_OPEN_MAIN,
      MENU_OPEN_TASKS,
      MENU_OPEN_NOTES,
      MENU_OPEN_ARTIFACTS,
      MENU_QUICK_NOTE,
      MENU_DAEMON_LOG,
      MENU_APP_LOG,
      MENU_RESTART_DAEMON,
      MENU_AUTOSTART,
      MENU_QUIT,
    ];
    let unique: std::collections::HashSet<_> = ids.iter().collect();
    assert_eq!(unique.len(), ids.len());
  }
}
