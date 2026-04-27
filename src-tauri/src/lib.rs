mod config;
mod external;
mod icon;
mod ports;
mod process;
mod scanner;

use process::ProcessState;

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
            icon::resolve_icon,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
