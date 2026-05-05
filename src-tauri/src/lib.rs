mod config;
mod external;
mod icon;
mod netstat;
mod ports;
mod process;
mod scanner;

use process::ProcessState;
use std::time::Duration;
use tauri::Emitter;

#[tauri::command]
fn scan_projects() -> Vec<scanner::Project> {
    scanner::scan()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(ProcessState::new())
        .invoke_handler(tauri::generate_handler![
            scan_projects,
            scanner::list_icon_candidates,
            process::start_project,
            process::stop_project,
            process::running_ids,
            config::get_project_config,
            config::set_project_config,
            config::set_project_hidden,
            config::add_extra_path,
            config::remove_extra_path,
            external::open_in_editor,
            external::open_in_terminal,
            external::open_in_files,
            external::kill_pid,
            icon::resolve_icon,
            netstat::list_system_ports,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(3));
                let mut last_sig: Vec<(u32, u16)> = Vec::new();
                loop {
                    interval.tick().await;
                    let snapshot = match tauri::async_runtime::spawn_blocking(
                        netstat::scan_listeners,
                    )
                    .await
                    {
                        Ok(s) => s,
                        Err(_) => continue,
                    };
                    let sig = netstat::snapshot_signature(&snapshot);
                    if sig != last_sig {
                        let _ = handle.emit("system-ports", &snapshot);
                        last_sig = sig;
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
