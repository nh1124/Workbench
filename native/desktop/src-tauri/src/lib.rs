mod applog;
mod commands;
mod daemon_lease;
mod launch_intent;
mod shortcuts;
mod titlebar;
mod variant;
mod window;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
      // A second launch of this executable lands here instead of starting a process. That
      // is how the resident asks an already-running app for a window: it spawns the exe
      // with the same flags either way, and Windows routes it to whichever case applies.
      #[cfg(desktop)]
      {
        launch_intent::open_for(app, launch_intent::from_args(&argv));
      }
    }))
    .setup(|app| {
      #[cfg(desktop)]
      {
        applog::name_this_process(app.handle());
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

        let args: Vec<String> = std::env::args().collect();
        let intent = launch_intent::from_args(&args);
        launch_intent::open_at_startup(app.handle(), intent)
          .map_err(|e| Box::<dyn std::error::Error>::from(e))?;

        commands::ensure_daemon_for_app(app.handle());
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
      applog::open_app_log,
      applog::log_ui_error,
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
      commands::set_daemon_exit_when_idle,
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
      // shared infrastructure — the resident keeps it, and it decides for itself once
      // nobody holds a lease.
      //
      // Stopping it outright is a deliberate act: the Settings button, the resident's tray,
      // or the installer.
      if matches!(event, tauri::RunEvent::Exit) {
        daemon_lease::release(app_handle);
      }
    });
}
