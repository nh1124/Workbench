mod commands;
mod daemon_guard;
mod daemon_lease;
mod secure_storage;
mod shortcuts;
mod titlebar;
mod variant;
mod window;

#[cfg(desktop)]
const TRAY_MENU_OPEN_MAIN_ID: &str = "tray-open-main";
#[cfg(desktop)]
const TRAY_MENU_DAEMON_LOG_ID: &str = "tray-daemon-log";
#[cfg(desktop)]
const TRAY_MENU_QUIT_ID: &str = "tray-quit";

#[cfg(desktop)]
fn initialize_tray_icon(app: &tauri::App) -> Result<(), String> {
  use tauri::menu::{Menu, MenuItem};
  use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

  let icon = app
    .default_window_icon()
    .cloned()
    .ok_or_else(|| "default window icon is not available".to_string())?;

  let open_main_item = MenuItem::with_id(
    app,
    TRAY_MENU_OPEN_MAIN_ID,
    "Open Workbench",
    true,
    None::<&str>,
  )
  .map_err(|error| format!("failed to create tray menu item: {error}"))?;
  // The sync daemon runs without a console window, so its output is reachable from here.
  let daemon_log_item = MenuItem::with_id(
    app,
    TRAY_MENU_DAEMON_LOG_ID,
    "Open sync daemon log",
    true,
    None::<&str>,
  )
  .map_err(|error| format!("failed to create tray menu item: {error}"))?;
  let quit_item = MenuItem::with_id(app, TRAY_MENU_QUIT_ID, "Quit", true, None::<&str>)
    .map_err(|error| format!("failed to create tray menu item: {error}"))?;
  let tray_menu = Menu::with_items(app, &[&open_main_item, &daemon_log_item, &quit_item])
    .map_err(|error| format!("failed to build tray menu: {error}"))?;

  TrayIconBuilder::with_id("workbench-tray")
    .icon(icon)
    .tooltip("Workbench")
    .menu(&tray_menu)
    .show_menu_on_left_click(false)
    .on_tray_icon_event(|tray, event| {
      if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
      } = event
      {
        if let Err(error) = window::show_or_create_main_window(tray.app_handle()) {
          eprintln!("[workbench-native] tray click failed to restore main window: {error}");
        }
      }
    })
    .on_menu_event(|app, event| {
      if event.id() == TRAY_MENU_OPEN_MAIN_ID {
        if let Err(error) = window::show_or_create_main_window(app) {
          eprintln!("[workbench-native] tray menu failed to restore main window: {error}");
        }
      } else if event.id() == TRAY_MENU_DAEMON_LOG_ID {
        if let Err(error) = commands::open_daemon_log(app.clone()) {
          eprintln!("[workbench-native] tray menu failed to open the daemon log: {error}");
        }
      } else if event.id() == TRAY_MENU_QUIT_ID {
        app.exit(0);
      }
    })
    .build(app)
    .map(|_| ())
    .map_err(|error| format!("failed to initialize tray icon: {error}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
      // Called when a second process is launched (e.g. taskbar shift+click).
      // Open a new main window unless the second instance is for a quick-note window.
      #[cfg(desktop)]
      {
        if window::should_open_new_main_window(&argv) {
          if let Err(error) = window::open_new_main_window(app) {
            eprintln!("[workbench-native] failed to open window for second instance: {error}");
          }
        }
      }
    }))
    .setup(|app| {
      #[cfg(desktop)]
      {
        // tauri.conf.json declares no windows: every window is built here so it gets the
        // shared WebView2 data directory and `disable_drag_drop_handler`. This sweep is a
        // safety net — a config-declared window would already hold the process to the
        // per-identifier default data folder, so closing it here cannot undo that.
        use tauri::Manager;
        for window in app.webview_windows().values() {
          let _ = window.close();
        }
        // The snap-layout subclass callback cannot capture state, so hand it the handle.
        titlebar::remember_app_handle(app.handle());
        window::open_new_main_window(app.handle())
          .map_err(|e| Box::<dyn std::error::Error>::from(e))?;

        if variant::current(app.handle()).is_main() {
          if let Err(error) = initialize_tray_icon(app) {
            eprintln!("[workbench-native] tray icon setup failed: {error}");
          }
        }

        commands::start_daemon_if_auto_start_enabled(app.handle());
        shortcuts::register(app);
      }
      Ok(())
    })
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![
      commands::secure_session_save,
      commands::secure_session_read,
      commands::secure_session_clear,
      commands::secure_local_daemon_client_save,
      commands::secure_local_daemon_client_status,
      commands::secure_local_daemon_client_clear,
      commands::open_main_window,
      commands::open_quick_note_window,
      commands::open_calendar_window,
      commands::open_app_window,
      commands::close_quick_note_window,
      shortcuts::set_global_shortcuts,
      commands::choose_sync_folder,
      commands::choose_downloads_folder,
      commands::reset_sync_folder,
      commands::reset_downloads_folder,
      commands::open_sync_folder,
      commands::open_downloads_folder,
      commands::read_daemon_status,
      commands::open_daemon_log,
      commands::read_local_daemon_api_token,
      commands::window_minimize,
      commands::window_toggle_maximize,
      commands::window_is_maximized,
      commands::open_variant_window,
      commands::window_close,
      commands::window_start_drag,
      titlebar::set_maximize_button_rect,
      commands::read_daemon_preferences,
      commands::set_daemon_auto_start,
      commands::set_daemon_resident_mode,
      commands::set_daemon_core_url,
      commands::start_daemon,
      commands::stop_daemon,
      commands::save_file_with_dialog,
      commands::open_file_in_os_app,
    ])
    .build(tauri::generate_context!())
    .expect("error while running workbench native application")
    .run(|app_handle, event| {
      // Quitting drops this app's claim on the daemon; it does not stop it. Killing here
      // took the daemon away from every other app that was still open, and the daemon is
      // shared infrastructure — it decides for itself once nobody holds a lease.
      //
      // Stopping it outright is a deliberate act: the Settings button, or the installer.
      if matches!(event, tauri::RunEvent::Exit) {
        daemon_lease::release(app_handle);
      }
    });
}
