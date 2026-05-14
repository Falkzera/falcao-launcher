// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK 2.46+ on Wayland crashes with "Error 71 (Protocol error)" via the DMABUF
    // renderer on several compositor/driver combos. Disable it before Tauri spins up the
    // WebView. No-op on X11/macOS/Windows.
    #[cfg(target_os = "linux")]
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");

    falcao_launcher_lib::run()
}
