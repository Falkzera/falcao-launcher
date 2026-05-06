//! Coletor de métricas por container via `docker stats`.

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use monitor_shared::{MetricRow, MetricSource, HOST_NAME};
use serde::Deserialize;
use tokio::process::Command;

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

    Ok(out)
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
}
