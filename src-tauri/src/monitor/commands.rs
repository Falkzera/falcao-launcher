//! Tauri commands expostos pro frontend.

use crate::monitor::queries::{ContainerInfo, HealthCheckSummary, MetricPoint, VmStatus};
use crate::monitor::{queries, tunnel::TunnelManager};
use chrono::{DateTime, Utc};
use deadpool_postgres::Pool;
use monitor_shared::HEALTH_ENDPOINTS;
use std::sync::Mutex;
use tauri::State;

pub struct MonitorState {
    pub tunnel: TunnelManager,
    pub pool: Mutex<Option<Pool>>,
    pub reader_password: String,
}

impl MonitorState {
    pub fn new() -> Self {
        let reader_password = std::env::var("MONITOR_READER_PASSWORD")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(read_password_from_config);

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

/// Lê MONITOR_READER_PASSWORD de ~/.config/falcao-launcher/.env como fallback
/// pra quando o app é lançado via atalho de teclado (sem env do shell).
fn read_password_from_config() -> String {
    let home = match std::env::var("HOME") {
        Ok(h) => h,
        Err(_) => return String::new(),
    };
    let path = std::path::PathBuf::from(home)
        .join(".config")
        .join("falcao-launcher")
        .join(".env");
    let contents = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return String::new(),
    };
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(rest) = line.strip_prefix("MONITOR_READER_PASSWORD=") {
            // Aceita valor com ou sem aspas
            return rest.trim().trim_matches('"').trim_matches('\'').to_string();
        }
    }
    String::new()
}

#[tauri::command]
pub async fn monitor_open_tunnel(state: State<'_, MonitorState>) -> Result<u16, String> {
    if state.reader_password.is_empty() {
        return Err(
            "MONITOR_READER_PASSWORD não configurada — \
             crie ~/.config/falcao-launcher/.env com a linha \
             MONITOR_READER_PASSWORD=<senha> ou exporte como variável de ambiente"
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

/// Resumo dos 3 endpoints monitorados externamente (Sprint 2).
/// Roda as 3 fetches em paralelo via tokio::join!. Em caso de falha individual,
/// retorna placeholder com `last_error` setado pra UI conseguir mostrar o card.
#[tauri::command]
pub async fn monitor_health_summary(
    state: State<'_, MonitorState>,
) -> Result<Vec<HealthCheckSummary>, String> {
    let pool = state
        .pool
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "tunnel closed".to_string())?;

    let (r0, r1, r2) = tokio::join!(
        queries::fetch_health_summary(&pool, HEALTH_ENDPOINTS[0]),
        queries::fetch_health_summary(&pool, HEALTH_ENDPOINTS[1]),
        queries::fetch_health_summary(&pool, HEALTH_ENDPOINTS[2]),
    );

    let mut out = Vec::with_capacity(3);
    for (i, r) in [r0, r1, r2].into_iter().enumerate() {
        match r {
            Ok(s) => out.push(s),
            Err(e) => {
                tracing::warn!("health summary {} failed: {e:#}", HEALTH_ENDPOINTS[i]);
                out.push(HealthCheckSummary {
                    endpoint: HEALTH_ENDPOINTS[i].to_string(),
                    last_ts: None,
                    last_ok: None,
                    last_status_code: None,
                    last_response_ms: None,
                    last_error: Some(format!("query failed: {e}")),
                    uptime_24h: None,
                    uptime_7d: None,
                    uptime_30d: None,
                    avg_response_ms_24h: None,
                });
            }
        }
    }
    Ok(out)
}
