use std::path::PathBuf;

/// Identifier of the main app. Variants derive their shared storage location from
/// this rather than from their own identifier, so every build lands on one folder.
const MAIN_IDENTIFIER: &str = "com.workbench.desktop";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AppVariant {
  Main,
  Tasks,
  Notes,
  Artifacts,
}

/// Absolute WebView2 user data directory shared by the main app and every variant.
///
/// On Windows, Tauri forces `data_directory` to `LocalData/<identifier>` when it is unset
/// (`tauri/src/manager/webview.rs:505-514`). Because each variant ships a different
/// identifier, every app got a private localStorage — which is why a variant could not see
/// the server URL configured in the main app and appeared to need a fresh sign-in. (The
/// session itself was always shared: it lives in Credential Manager under a fixed name.)
///
/// Returning the main app's own default path means the main app keeps the storage it
/// already has, and the variants join it rather than everyone migrating.
///
/// A process can only ever use ONE user data folder. Every window must therefore get this
/// same directory, and `tauri.conf.json` must declare no windows of its own — a config
/// window would be created first on the default path and the next window would fail.
/// Only Windows needs this: the exe-relative default is a WebView2 behaviour. On other
/// platforms the webview data location is not derived from the executable path.
#[cfg(target_os = "windows")]
pub fn shared_webview_data_directory() -> Option<PathBuf> {
  std::env::var_os("LOCALAPPDATA")
    .filter(|value| !value.is_empty())
    .map(|root| PathBuf::from(root).join(MAIN_IDENTIFIER))
}

#[cfg(not(target_os = "windows"))]
pub fn shared_webview_data_directory() -> Option<PathBuf> {
  None
}

pub fn from_identifier(identifier: &str) -> AppVariant {
  match identifier {
    "com.workbench.desktop" => AppVariant::Main,
    "com.workbench.desktop.tasks" => AppVariant::Tasks,
    "com.workbench.desktop.notes" => AppVariant::Notes,
    "com.workbench.desktop.artifacts" => AppVariant::Artifacts,
    _ => AppVariant::Main,
  }
}

pub fn current(app: &tauri::AppHandle) -> AppVariant {
  from_identifier(&app.config().identifier)
}

impl AppVariant {
  pub fn name(&self) -> &'static str {
    match self {
      AppVariant::Main => "main",
      AppVariant::Tasks => "tasks",
      AppVariant::Notes => "notes",
      AppVariant::Artifacts => "artifacts",
    }
  }

  pub fn is_main(&self) -> bool {
    matches!(self, AppVariant::Main)
  }

  pub fn window_title(&self) -> &'static str {
    match self {
      AppVariant::Main => "Workbench",
      AppVariant::Tasks => "Workbench Tasks",
      AppVariant::Notes => "Workbench Notes",
      AppVariant::Artifacts => "Workbench Artifacts",
    }
  }
}

pub fn initialization_script(variant: AppVariant) -> String {
  format!("window.__WORKBENCH_VARIANT__ = \"{}\";", variant.name())
}

#[cfg(test)]
mod tests {
  use super::{from_identifier, initialization_script, AppVariant};

  #[test]
  fn maps_exact_identifiers_to_variants() {
    assert_eq!(from_identifier("com.workbench.desktop"), AppVariant::Main);
    assert_eq!(
      from_identifier("com.workbench.desktop.tasks"),
      AppVariant::Tasks
    );
    assert_eq!(
      from_identifier("com.workbench.desktop.notes"),
      AppVariant::Notes
    );
    assert_eq!(
      from_identifier("com.workbench.desktop.artifacts"),
      AppVariant::Artifacts
    );
  }

  #[test]
  fn unknown_identifier_defaults_to_main() {
    assert_eq!(
      from_identifier("com.workbench.desktop.bogus"),
      AppVariant::Main
    );
  }

  #[test]
  fn empty_identifier_defaults_to_main() {
    assert_eq!(from_identifier(""), AppVariant::Main);
  }

  #[test]
  fn prefix_without_variant_separator_defaults_to_main() {
    assert_eq!(
      from_identifier("com.workbench.desktoptasks"),
      AppVariant::Main
    );
  }

  #[test]
  fn variant_names_are_stable() {
    assert_eq!(AppVariant::Main.name(), "main");
    assert_eq!(AppVariant::Tasks.name(), "tasks");
    assert_eq!(AppVariant::Notes.name(), "notes");
    assert_eq!(AppVariant::Artifacts.name(), "artifacts");
  }

  #[test]
  fn initialization_scripts_assign_each_variant_name() {
    for variant in [
      AppVariant::Main,
      AppVariant::Tasks,
      AppVariant::Notes,
      AppVariant::Artifacts,
    ] {
      let expected = format!("window.__WORKBENCH_VARIANT__ = \"{}\";", variant.name());
      assert!(initialization_script(variant).contains(&expected));
    }
  }
}
