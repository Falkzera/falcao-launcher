//! Tauri commands expostos pro frontend.

use crate::monitor::queries::{ContainerInfo, MetricPoint, VmStatus};
use crate::monitor::{queries, tunnel::TunnelManager};
use chrono::{DateTime, Utc};
use deadpool_postgres::Pool;
use std::sync::Mutex;
use tauri::State;

pub struct MonitorState {
    pub tunnel: TunnelManager,
    pub pool: Mutex<Option<Pool>>,
    pub reader_password: String,
}

impl MonitorState {
    pub fn new() -> Self {
        let reader_password = std::env::var("MONITOR_READER_PASSWORD").unwrap_or_default();
        Self {
            tunnel: TunnelManager::new(),
            pool: Mutex::new(None),
            reader_password,
        }
    }
}

impl Default for MonitorState {
    fn default() -> Self {
        Self::new()
    }
}

#[tauri::command]
pub async fn monitor_open_tunnel(state: State<'_, MonitorState>) -> Result<u16, String> {
    if state.reader_password.is_empty() {
        return Err(
            "MONITOR_READER_PASSWORD não configurada — \
             defina em ~/Projects/falcao-launcher/.env.local ou no ambiente"
                .to_string(),
        );
    }

    let port = state.tunnel.open().await.map_err(|e| e.to_string())?;
    let url = format!(
        "postgresql://monitor_reader:{}@localhost:{}/falcao_monitor",
        urlencoding::encode(&state.reader_password),
        port
    );
    let pool = queries::build_pool(&url).map_err(|e| e.to_string())?;
    *state.pool.lock().unwrap() = Some(pool);
    Ok(port)
}

#[tauri::command]
pub async fn monitor_close_tunnel(state: State<'_, MonitorState>) -> Result<(), String> {
    state.tunnel.close().await.map_err(|e| e.to_string())?;
    *state.pool.lock().unwrap() = None;
    Ok(())
}

#[tauri::command]
pub async fn monitor_vm_status(state: State<'_, MonitorState>) -> Result<VmStatus, String> {
    let pool = state
        .pool
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "tunnel closed".to_string())?;
    queries::vm_status(&pool).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn monitor_list_containers(
    state: State<'_, MonitorState>,
) -> Result<Vec<ContainerInfo>, String> {
    let pool = state
        .pool
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "tunnel closed".to_string())?;
    queries::list_containers(&pool)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn monitor_metric_series(
    state: State<'_, MonitorState>,
    source: String,
    resource: Option<String>,
    metric: String,
    since_iso: String,
    until_iso: Option<String>,
    bucket: Option<String>,
) -> Result<Vec<MetricPoint>, String> {
    let pool = state
        .pool
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "tunnel closed".to_string())?;
    let since: DateTime<Utc> = since_iso
        .parse()
        .map_err(|e: chrono::ParseError| e.to_string())?;
    let until: Option<DateTime<Utc>> = match until_iso {
        Some(s) => Some(s.parse().map_err(|e: chrono::ParseError| e.to_string())?),
        None => None,
    };
    queries::fetch_metric_series(
        &pool,
        &source,
        resource.as_deref(),
        &metric,
        since,
        until,
        bucket.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn monitor_fetch_logs(container: String, lines: u32) -> Result<String, String> {
    // Validate container name to prevent shell injection
    if container.is_empty()
        || !container
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))
    {
        return Err(format!("invalid container name: {container}"));
    }
    if lines == 0 || lines > 10_000 {
        return Err("lines must be between 1 and 10000".to_string());
    }

    let output = tokio::process::Command::new("ssh")
        .args([
            "falcao@162.55.217.189",
            &format!("docker logs --tail {} {} 2>&1", lines, container),
        ])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}
