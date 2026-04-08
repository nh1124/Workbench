mod commands;
mod secure_storage;
mod shortcuts;
mod window;

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
