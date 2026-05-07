//! Coletor de métricas por container via `docker stats`.
//!
//! Além de `docker stats` (CPU/RAM/IO), faz um `docker inspect` em batch pra
//! ler o label `monitor.stack` (Sprint 2 — agrupamento frontend Vercel +
//! backend container em "stacks em produção"). Containers sem a label
//! continuam emitindo `labels: None` (sem regressão).

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use monitor_shared::{MetricRow, MetricSource, HOST_NAME};
use serde::Deserialize;
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use tokio::process::Command;
use tracing::warn;

#[derive(Debug, Deserialize)]
struct DockerStat {
    #[serde(rename = "Name")]
    name: String,
    #[serde(rename = "CPUPerc")]
    cpu_perc: String,
    #[serde(rename = "MemUsage")]
    mem_usage: String,
    #[serde(rename = "MemPerc")]
    mem_perc: String,
    #[serde(rename = "NetIO")]
    net_io: String,
    #[serde(rename = "BlockIO")]
    block_io: String,
}

pub async fn collect(ts: DateTime<Utc>) -> Result<Vec<MetricRow>> {
    let output = Command::new("docker")
        .args(["stats", "--no-stream", "--format", "{{json .}}"])
        .output()
        .await
        .context("execute docker stats")?;

    if !output.status.success() {
        anyhow::bail!(
            "docker stats failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut out = Vec::new();
    let mut names: Vec<String> = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let stat: DockerStat = serde_json::from_str(line).context("parse docker stats line")?;
        names.push(stat.name.clone());
        push_container_metrics(&mut out, ts, &stat);
    }

    // health: query separada via `docker inspect` por container (best-effort).
    for name in &names {
        if let Some(v) = read_container_health(name).await {
            out.push(metric(ts, name, "health", v));
        }
    }

    // Labels: 1 batch `docker inspect` pra todos os containers ativos.
    // Falha aqui é best-effort — métricas continuam sem labels (sem regressão).
    let labels_by_name = match fetch_labels(&names).await {
        Ok(m) => m,
        Err(e) => {
            warn!("container: fetch_labels failed (sem stack labels nesse tick): {e:#}");
            HashMap::new()
        }
    };
    propagate_stack_labels(&mut out, &labels_by_name);

    Ok(out)
}

/// Anexa `{"stack": "<nome>"}` em `MetricRow.labels` pra cada row cujo
/// `resource` tenha label `monitor.stack` preenchida no inspect.
fn propagate_stack_labels(rows: &mut [MetricRow], labels_by_name: &HashMap<String, JsonValue>) {
    if labels_by_name.is_empty() {
        return;
    }
    for r in rows.iter_mut() {
        let Some(name) = r.resource.as_deref() else {
            continue;
        };
        if let Some(labels) = labels_by_name.get(name) {
            if let Some(stack) = extract_stack(labels) {
                r.labels = Some(serde_json::json!({ "stack": stack }));
            }
        }
    }
}

/// Roda `docker inspect <c1> <c2> ... --format '{{.Name}}\t{{json .Config.Labels}}'`
/// num único spawn — bem mais barato que N chamadas separadas.
///
/// Retorna `HashMap<container_name, labels_json>`. Container sem labels
/// (`null` no JSON) é incluído como `Value::Null` — `extract_stack` lida.
async fn fetch_labels(names: &[String]) -> Result<HashMap<String, JsonValue>> {
    if names.is_empty() {
        return Ok(HashMap::new());
    }
    let output = Command::new("docker")
        .arg("inspect")
        .args(names)
        .arg("--format")
        .arg("{{.Name}}\t{{json .Config.Labels}}")
        .output()
        .await
        .context("execute docker inspect (labels)")?;

    if !output.status.success() {
        anyhow::bail!(
            "docker inspect failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_inspect_labels(&stdout))
}

/// Parser de `{{.Name}}\t{{json .Config.Labels}}` (1 linha por container).
/// Separado pra ser testável sem rodar docker.
fn parse_inspect_labels(stdout: &str) -> HashMap<String, JsonValue> {
    let mut out = HashMap::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(2, '\t');
        let raw_name = match parts.next() {
            Some(n) => n,
            None => continue,
        };
        // docker prefixa nome com '/' (ex: "/caddy") — o `docker stats` não. Normaliza.
        let name = raw_name.trim_start_matches('/').to_string();
        let json_str = match parts.next() {
            Some(s) => s,
            None => continue,
        };
        if let Ok(labels) = serde_json::from_str::<JsonValue>(json_str) {
            out.insert(name, labels);
        }
    }
    out
}

/// Extrai `monitor.stack` do JSON de labels do container.
/// Retorna `None` se label ausente, valor não-string, ou labels=null.
fn extract_stack(labels: &JsonValue) -> Option<String> {
    labels.get("monitor.stack")?.as_str().map(String::from)
}

/// Map: "healthy" -> 1.0, "unhealthy"/"starting" -> 0.0, sem healthcheck -> None (skip).
async fn read_container_health(name: &str) -> Option<f64> {
    let output = Command::new("docker")
        .args([
            "inspect",
            "--format",
            "{{.State.Health.Status}}",
            name,
        ])
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&output.stdout);
    parse_health_status(&s)
}

/// Output do `docker inspect` é "healthy\n", "unhealthy\n", "starting\n",
/// "<no value>\n" (sem healthcheck) ou string vazia.
fn parse_health_status(s: &str) -> Option<f64> {
    let trimmed = s.trim();
    match trimmed {
        "healthy" => Some(1.0),
        "unhealthy" | "starting" => Some(0.0),
        _ => None, // "<no value>", "", outros → skip
    }
}

fn push_container_metrics(out: &mut Vec<MetricRow>, ts: DateTime<Utc>, s: &DockerStat) {
    if let Some(v) = parse_pct(&s.cpu_perc) {
        out.push(metric(ts, &s.name, "cpu_pct", v));
    }
    if let Some(v) = parse_pct(&s.mem_perc) {
        out.push(metric(ts, &s.name, "mem_pct", v));
    }
    if let Some(v) = parse_mem_usage(&s.mem_usage) {
        out.push(metric(ts, &s.name, "mem_used_bytes", v));
    }
    if let Some(v) = parse_mem_limit(&s.mem_usage) {
        out.push(metric(ts, &s.name, "mem_limit_bytes", v));
    }
    if let Some((rx, tx)) = parse_io_pair(&s.net_io) {
        out.push(metric(ts, &s.name, "net_rx_bytes", rx));
        out.push(metric(ts, &s.name, "net_tx_bytes", tx));
    }
    if let Some((r, w)) = parse_io_pair(&s.block_io) {
        out.push(metric(ts, &s.name, "block_read_bytes", r));
        out.push(metric(ts, &s.name, "block_write_bytes", w));
    }
}

/// "12.34%" -> 12.34
fn parse_pct(s: &str) -> Option<f64> {
    s.trim_end_matches('%').trim().parse().ok()
}

/// "47.5MiB / 3.7GiB" -> 47.5MiB em bytes
fn parse_mem_usage(s: &str) -> Option<f64> {
    let used = s.split('/').next()?.trim();
    parse_size(used)
}

/// "47.5MiB / 3.7GiB" -> 3.7GiB em bytes
fn parse_mem_limit(s: &str) -> Option<f64> {
    let mut parts = s.split('/');
    parts.next()?; // discarda used
    let limit = parts.next()?.trim();
    parse_size(limit)
}

/// "1.23kB / 4.56MB" -> (1.23kB, 4.56MB) em bytes
fn parse_io_pair(s: &str) -> Option<(f64, f64)> {
    let mut parts = s.split('/');
    let a = parse_size(parts.next()?.trim())?;
    let b = parse_size(parts.next()?.trim())?;
    Some((a, b))
}

/// "1.23GiB" / "456MB" / "0B" -> bytes
fn parse_size(s: &str) -> Option<f64> {
    let s = s.trim();
    let (num_str, mult) = match () {
        _ if s.ends_with("GiB") => (&s[..s.len() - 3], 1024.0_f64.powi(3)),
        _ if s.ends_with("MiB") => (&s[..s.len() - 3], 1024.0_f64.powi(2)),
        _ if s.ends_with("KiB") => (&s[..s.len() - 3], 1024.0_f64),
        _ if s.ends_with("GB")  => (&s[..s.len() - 2], 1e9),
        _ if s.ends_with("MB")  => (&s[..s.len() - 2], 1e6),
        _ if s.ends_with("kB")  => (&s[..s.len() - 2], 1e3),
        _ if s.ends_with("B")   => (&s[..s.len() - 1], 1.0),
        _ => return None,
    };
    num_str.trim().parse::<f64>().ok().map(|n| n * mult)
}

fn metric(ts: DateTime<Utc>, name: &str, m: &str, value: f64) -> MetricRow {
    MetricRow {
        ts,
        host: HOST_NAME.to_string(),
        source: MetricSource::Container,
        resource: Some(name.to_string()),
        metric: m.to_string(),
        value: Some(value),
        labels: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_docker_stats_json_line() {
        let line = r#"{"Name":"caddy","CPUPerc":"0.05%","MemUsage":"12.5MiB / 3.7GiB","MemPerc":"0.33%","NetIO":"1.2kB / 5.4kB","BlockIO":"0B / 100kB"}"#;
        let stat: DockerStat = serde_json::from_str(line).unwrap();
        assert_eq!(stat.name, "caddy");
        assert_eq!(stat.cpu_perc, "0.05%");
    }

    #[test]
    fn parses_pct() {
        assert_eq!(parse_pct("12.34%"), Some(12.34));
        assert_eq!(parse_pct("0%"), Some(0.0));
        assert_eq!(parse_pct("--"), None);
    }

    #[test]
    fn parses_size_variants() {
        assert_eq!(parse_size("1KiB"), Some(1024.0));
        assert_eq!(parse_size("1MiB"), Some(1024.0 * 1024.0));
        assert_eq!(parse_size("1GiB"), Some(1024.0 * 1024.0 * 1024.0));
        assert_eq!(parse_size("1kB"), Some(1000.0));
        assert_eq!(parse_size("1MB"), Some(1_000_000.0));
        assert_eq!(parse_size("0B"), Some(0.0));
        assert_eq!(parse_size("garbage"), None);
    }

    #[test]
    fn parses_io_pair_values() {
        let r = parse_io_pair("1.2kB / 5.4kB").unwrap();
        assert!((r.0 - 1200.0).abs() < 0.01);
        assert!((r.1 - 5400.0).abs() < 0.01);
    }

    #[test]
    fn parses_mem_limit_from_usage_string() {
        assert!((parse_mem_limit("100MiB / 1GiB").unwrap()
            - 1024.0 * 1024.0 * 1024.0)
            .abs()
            < 0.01);
        assert!((parse_mem_limit("47.5MiB / 3.7GiB").unwrap()
            - 3.7 * 1024.0_f64.powi(3))
            .abs()
            < 1.0);
        assert_eq!(parse_mem_limit("garbage"), None);
    }

    #[test]
    fn parses_health_status_variants() {
        assert_eq!(parse_health_status("healthy\n"), Some(1.0));
        assert_eq!(parse_health_status("  healthy  "), Some(1.0));
        assert_eq!(parse_health_status("unhealthy\n"), Some(0.0));
        assert_eq!(parse_health_status("starting\n"), Some(0.0));
        // sem healthcheck configurado: docker imprime "<no value>"
        assert_eq!(parse_health_status("<no value>\n"), None);
        assert_eq!(parse_health_status(""), None);
    }

    #[test]
    fn pushes_metrics_for_container() {
        let s = DockerStat {
            name: "x".into(),
            cpu_perc: "5%".into(),
            mem_usage: "100MiB / 1GiB".into(),
            mem_perc: "10%".into(),
            net_io: "1kB / 2kB".into(),
            block_io: "0B / 0B".into(),
        };
        let mut out = vec![];
        push_container_metrics(&mut out, Utc::now(), &s);
        assert!(out.iter().any(|r| r.metric == "cpu_pct"));
        assert!(out.iter().any(|r| r.metric == "mem_pct"));
        assert!(out.iter().any(|r| r.metric == "mem_used_bytes"));
        assert!(out.iter().any(|r| r.metric == "mem_limit_bytes"));
        assert!(out.iter().any(|r| r.metric == "net_rx_bytes"));
    }

    #[test]
    fn extracts_monitor_stack_label() {
        let labels = serde_json::json!({"monitor.stack": "falcao-financas", "other": "x"});
        assert_eq!(extract_stack(&labels).as_deref(), Some("falcao-financas"));
    }

    #[test]
    fn no_label_returns_none() {
        let labels = serde_json::json!({"other": "x"});
        assert!(extract_stack(&labels).is_none());

        // Container sem labels (Config.Labels = null) também deve dar None.
        let null_labels = serde_json::json!(null);
        assert!(extract_stack(&null_labels).is_none());
    }

    #[test]
    fn parse_inspect_labels_strips_leading_slash() {
        // `docker inspect` prefixa nome com `/`, `docker stats` não.
        let stdout = "/caddy\t{\"monitor.stack\":\"falcao-financas\"}\n/db\tnull\n";
        let map = parse_inspect_labels(stdout);
        assert!(map.contains_key("caddy"));
        assert!(map.contains_key("db"));
        assert_eq!(extract_stack(&map["caddy"]).as_deref(), Some("falcao-financas"));
        assert!(extract_stack(&map["db"]).is_none());
    }

    #[test]
    fn propagate_stack_labels_attaches_only_to_matching_rows() {
        let ts = Utc::now();
        let mut rows = vec![
            metric(ts, "caddy", "cpu_pct", 1.0),
            metric(ts, "falcao-financas", "cpu_pct", 2.0),
        ];
        let mut labels = HashMap::new();
        labels.insert(
            "falcao-financas".to_string(),
            serde_json::json!({"monitor.stack": "falcao-financas"}),
        );
        propagate_stack_labels(&mut rows, &labels);

        assert!(rows[0].labels.is_none(), "caddy não tem stack");
        assert_eq!(
            rows[1].labels.as_ref().and_then(|v| v.get("stack")).and_then(|v| v.as_str()),
            Some("falcao-financas")
        );
    }
}
