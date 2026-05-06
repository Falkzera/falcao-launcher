//! Coletor de métricas via `hcloud` CLI (server describe).

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use monitor_shared::{MetricRow, MetricSource, HOST_NAME};
use serde_json::Value;
use tokio::process::Command;

pub async fn collect(ts: DateTime<Utc>) -> Result<Vec<MetricRow>> {
    let output = Command::new("hcloud")
        .args(["server", "describe", HOST_NAME, "-o", "json"])
        .output()
        .await
        .context("execute hcloud")?;

    if !output.status.success() {
        anyhow::bail!(
            "hcloud failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    let value: Value = serde_json::from_slice(&output.stdout).context("parse hcloud json")?;

    let mut out = Vec::new();

    if let Some(v) = value.get("included_traffic").and_then(Value::as_f64) {
        out.push(metric(ts, "included_traffic_bytes", v));
    }
    if let Some(v) = value.get("outgoing_traffic").and_then(Value::as_f64) {
        out.push(metric(ts, "outgoing_traffic_bytes", v));
    }
    if let Some(v) = value.get("ingoing_traffic").and_then(Value::as_f64) {
        out.push(metric(ts, "ingoing_traffic_bytes", v));
    }
    if let Some(s) = value.get("status").and_then(Value::as_str) {
        let v = if s == "running" { 1.0 } else { 0.0 };
        out.push(metric(ts, "status_running", v));
    }

    Ok(out)
}

fn metric(ts: DateTime<Utc>, name: &str, value: f64) -> MetricRow {
    MetricRow {
        ts,
        host: HOST_NAME.to_string(),
        source: MetricSource::Hetzner,
        resource: None,
        metric: name.to_string(),
        value: Some(value),
        labels: None,
    }
}
