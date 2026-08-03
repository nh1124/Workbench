fn main() {
  // Only Windows consumes the .rc; on other platforms tray.rs loads the icon another way.
  #[cfg(windows)]
  {
    println!("cargo:rerun-if-changed=resident.rc");
    println!("cargo:rerun-if-changed=../desktop/src-tauri/icons/icon.ico");
    embed_resource::compile("resident.rc", embed_resource::NONE)
      .manifest_required()
      .expect("failed to embed the resident tray icon");
  }
}
