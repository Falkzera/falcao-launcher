mod claude;
mod config;
mod external;
mod icon;
mod monitor;
mod netstat;
mod ports;
mod process;
mod scanner;
mod skills;

use claude::ClaudeState;
use monitor::commands::{
    monitor_close_tunnel, monitor_fetch_logs, monitor_fetch_logs_range, monitor_health_summary,
    monitor_list_containers, monitor_list_stacks, monitor_metric_series, monitor_open_tunnel,
    monitor_stack_detail, monitor_vm_status, MonitorState,
};
use process::ProcessState;
use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, Manager};

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
        .manage(MonitorState::new())
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
            external::spawn_claude,
            icon::resolve_icon,
            netstat::list_system_ports,
            claude::claude_snapshot,
            claude::list_claude_sessions,
            claude::aggregate_tokens,
            skills::list_skills,
            skills::read_skill_content,
            monitor_open_tunnel,
            monitor_close_tunnel,
            monitor_vm_status,
            monitor_list_containers,
            monitor_metric_series,
            monitor_fetch_logs,
            monitor_fetch_logs_range,
            monitor_health_summary,
            monitor_list_stacks,
            monitor_stack_detail,
        ])
        .setup(|app| {
            // System ports scanner — periódico
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

            // Claude awareness watcher — file watch + fallback poll
            let claude_handle = app.handle().clone();
            let claude_state = app.state::<Arc<ClaudeState>>().inner().clone();
            claude::start_watcher(claude_handle, claude_state);

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
