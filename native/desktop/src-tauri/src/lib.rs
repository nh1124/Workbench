mod commands;
mod secure_storage;
mod shortcuts;
mod window;

#[cfg(desktop)]
const TRAY_MENU_OPEN_MAIN_ID: &str = "tray-open-main";
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
  let quit_item = MenuItem::with_id(app, TRAY_MENU_QUIT_ID, "Quit", true, None::<&str>)
    .map_err(|error| format!("failed to create tray menu item: {error}"))?;
  let tray_menu = Menu::with_items(app, &[&open_main_item, &quit_item])
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
        // Close any windows created from tauri.conf.json (they lack disable_drag_drop_handler).
        // We recreate the main window here so drag-and-drop works correctly in the WebView.
        use tauri::Manager;
        for window in app.webview_windows().values() {
          let _ = window.close();
        }
        window::open_new_main_window(app.handle())
          .map_err(|e| Box::<dyn std::error::Error>::from(e))?;

        if let Err(error) = initialize_tray_icon(app) {
          eprintln!("[workbench-native] tray icon setup failed: {error}");
        }

        shortcuts::register(app);
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      commands::secure_session_save,
      commands::secure_session_read,
      commands::secure_session_clear,
      commands::open_quick_note_window,
      commands::close_quick_note_window,
    ])
    .run(tauri::generate_context!())
    .expect("error while running workbench native application");
}
