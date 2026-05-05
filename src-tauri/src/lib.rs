mod claude;
mod config;
mod external;
mod icon;
mod ports;
mod process;
mod scanner;

use process::ProcessState;
use std::sync::Arc;
use claude::ClaudeState;
use tauri::Manager;

#[tauri::command]
fn scan_projects() -> Vec<scanner::Project> {
    scanner::scan()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(ProcessState::new())
        .manage(Arc::new(ClaudeState::new()))
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
            external::spawn_claude,
            icon::resolve_icon,
            claude::claude_snapshot,
            claude::list_claude_sessions,
            claude::aggregate_tokens,
        ])
        .setup(|app| {
            // Claude awareness watcher
            let claude_handle = app.handle().clone();
            let claude_state = app.state::<Arc<ClaudeState>>().inner().clone();
            claude::start_watcher(claude_handle, claude_state);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
