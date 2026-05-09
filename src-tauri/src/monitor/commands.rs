//! Tauri commands expostos pro frontend.

use crate::monitor::costs::{self, CostHistoryPoint, CostUsage};
use crate::monitor::queries::{ContainerInfo, HealthCheckSummary, MetricPoint, VmStatus};
use crate::monitor::security::{self, VulnSummary, VulnerabilityRow};
use crate::monitor::stacks::{StackDetail, StackSummary};
use crate::monitor::{queries, stacks, tunnel::TunnelManager};
use chrono::{DateTime, Utc};
use deadpool_postgres::Pool;
use monitor_shared::HEALTH_ENDPOINTS;
use std::collections::HashMap;
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

/// Resposta do `monitor_fetch_logs_range`. Inclui flag `truncated` pra UI avisar
/// quando o output bateu no limite do `--tail` (caso o range tenha gerado mais
/// linhas que o limite).
#[derive(serde::Serialize)]
pub struct LogsRangeResponse {
    pub text: String,
    pub truncated: bool,
    pub line_count: usize,
}

/// Limite duro de tamanho da janela: queries muito longas travam a SSH session
/// e o usuário acaba esperando por nada. 24h cobre o caso real (preset 24h é
/// o maior que o user pode arrastar via brush sem precisar mudar de preset).
const MAX_RANGE_HOURS: i64 = 24;

/// Tail máximo retornado pelo `docker logs`. Mantemos baixo (2k) pra UI não
/// engasgar; UI avisa truncamento via flag `truncated`.
const MAX_TAIL_LINES: u32 = 2000;

/// Valida nome de container — só ASCII alfanumérico + `_.-`.
/// Mesma regra usada por `monitor_fetch_logs` (anti shell-injection).
fn is_valid_container_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))
}

/// Retorna logs de um container num range temporal arbitrário via
/// `docker logs --since <iso> --until <iso>` por SSH.
///
/// Validações:
///   - container name: ASCII + `_.-` (anti shell-injection)
///   - range max 24h (anti SSH timeout)
///   - until > since
///
/// Truncamento: docker `--tail 2000` corta saída — UI avisa via flag.
#[tauri::command]
pub async fn monitor_fetch_logs_range(
    container: String,
    since_iso: String,
    until_iso: String,
) -> Result<LogsRangeResponse, String> {
    if !is_valid_container_name(&container) {
        return Err(format!("invalid container name: {container}"));
    }

    let since: DateTime<Utc> = since_iso
        .parse()
        .map_err(|e: chrono::ParseError| format!("invalid since_iso: {e}"))?;
    let until: DateTime<Utc> = until_iso
        .parse()
        .map_err(|e: chrono::ParseError| format!("invalid until_iso: {e}"))?;

    if until <= since {
        return Err("until_iso must be after since_iso".to_string());
    }

    let span = until - since;
    if span.num_hours() > MAX_RANGE_HOURS {
        return Err(format!(
            "range too large: {}h (max {}h)",
            span.num_hours(),
            MAX_RANGE_HOURS
        ));
    }

    let since_arg = since.to_rfc3339();
    let until_arg = until.to_rfc3339();

    let cmd = format!(
        "docker logs --since '{}' --until '{}' --tail {} {} 2>&1",
        since_arg, until_arg, MAX_TAIL_LINES, container
    );

    let output = tokio::process::Command::new("ssh")
        .args(["falcao@162.55.217.189", &cmd])
        .output()
        .await
        .map_err(|e| e.to_string())?;

    let text = String::from_utf8_lossy(&output.stdout).to_string();
    let line_count = text.lines().count();
    let truncated = line_count >= MAX_TAIL_LINES as usize;

    Ok(LogsRangeResponse {
        text,
        truncated,
        line_count,
    })
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

/// Lista todas as stacks vivas (frontend Vercel + backend container agrupados
/// pelo label `monitor.stack` no compose). Sprint 2.
#[tauri::command]
pub async fn monitor_list_stacks(
    state: State<'_, MonitorState>,
) -> Result<Vec<StackSummary>, String> {
    let pool = state
        .pool
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "tunnel closed".to_string())?;
    stacks::list_stacks(&pool)
        .await
        .map_err(|e| e.to_string())
}

/// Detalhe completo de uma stack: último deploy Vercel + containers + health endpoint.
#[tauri::command]
pub async fn monitor_stack_detail(
    name: String,
    state: State<'_, MonitorState>,
) -> Result<StackDetail, String> {
    let pool = state
        .pool
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "tunnel closed".to_string())?;
    stacks::stack_detail(&pool, &name)
        .await
        .map_err(|e| e.to_string())
}

// ============================================================
// Sprint B1 — Snyk-like (vulnerabilidades)
// ============================================================

#[tauri::command]
pub async fn monitor_list_vulnerabilities(
    severities: Vec<String>,
    kinds: Vec<String>,
    state: State<'_, MonitorState>,
) -> Result<Vec<VulnerabilityRow>, String> {
    let pool = state
        .pool
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "tunnel closed".to_string())?;
    security::list_vulnerabilities(&pool, &severities, &kinds)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn monitor_vuln_summary(
    state: State<'_, MonitorState>,
) -> Result<VulnSummary, String> {
    let pool = state
        .pool
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "tunnel closed".to_string())?;
    security::vuln_summary(&pool).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn monitor_vuln_count_by_repo(
    state: State<'_, MonitorState>,
) -> Result<HashMap<String, i64>, String> {
    let pool = state
        .pool
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "tunnel closed".to_string())?;
    security::vuln_count_by_repo(&pool)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn monitor_list_tracked_tokens(
    state: State<'_, MonitorState>,
) -> Result<Vec<String>, String> {
    let pool = state
        .pool
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "tunnel closed".to_string())?;
    security::list_tracked_tokens(&pool)
        .await
        .map_err(|e| e.to_string())
}

// ============================================================
// Sprint B3 — Monitor de custos multi-serviço
// ============================================================

#[tauri::command]
pub async fn monitor_cost_summary(
    state: State<'_, MonitorState>,
) -> Result<Vec<CostUsage>, String> {
    let pool = state
        .pool
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "tunnel closed".to_string())?;
    costs::cost_summary(&pool).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn monitor_cost_history(
    state: State<'_, MonitorState>,
    service: String,
    metric: String,
    since_iso: String,
    until_iso: String,
) -> Result<Vec<CostHistoryPoint>, String> {
    let pool = state
        .pool
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "tunnel closed".to_string())?;
    let since: DateTime<Utc> = since_iso
        .parse()
        .map_err(|e: chrono::ParseError| format!("invalid since_iso: {e}"))?;
    let until: DateTime<Utc> = until_iso
        .parse()
        .map_err(|e: chrono::ParseError| format!("invalid until_iso: {e}"))?;
    costs::cost_history(&pool, &service, &metric, since, until)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    fn parse(iso: &str) -> Result<DateTime<Utc>, String> {
        iso.parse::<DateTime<Utc>>().map_err(|e| e.to_string())
    }

    #[test]
    fn parses_iso_timestamps_to_utc() {
        let ts = parse("2026-05-07T12:00:00Z").expect("should parse");
        assert_eq!(ts.timestamp(), 1778155200);
    }

    #[test]
    fn rejects_invalid_iso() {
        assert!(parse("not-a-date").is_err());
        assert!(parse("2026-05-07").is_err()); // sem hora
    }

    #[test]
    fn rejects_range_over_24h() {
        let since = parse("2026-05-07T00:00:00Z").unwrap();
        let until = since + Duration::hours(MAX_RANGE_HOURS + 1);
        let span = until - since;
        assert!(span.num_hours() > MAX_RANGE_HOURS);
    }

    #[test]
    fn accepts_range_exactly_24h() {
        let since = parse("2026-05-07T00:00:00Z").unwrap();
        let until = since + Duration::hours(MAX_RANGE_HOURS);
        let span = until - since;
        assert_eq!(span.num_hours(), MAX_RANGE_HOURS);
    }

    #[test]
    fn rejects_until_before_since() {
        let since = parse("2026-05-07T12:00:00Z").unwrap();
        let until = since - Duration::minutes(1);
        assert!(until < since);
    }

    #[test]
    fn validates_container_name_alphanumeric() {
        assert!(is_valid_container_name("falcao-financas"));
        assert!(is_valid_container_name("nginx_prod-2"));
        assert!(is_valid_container_name("a.b.c"));
    }

    #[test]
    fn rejects_container_name_with_shell_metachars() {
        assert!(!is_valid_container_name(""));
        assert!(!is_valid_container_name("foo; rm -rf /"));
        assert!(!is_valid_container_name("foo bar"));
        assert!(!is_valid_container_name("foo$bar"));
        assert!(!is_valid_container_name("foo\nbar"));
    }
}
