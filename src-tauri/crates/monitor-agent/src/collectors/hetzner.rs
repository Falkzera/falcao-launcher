//! Coletor de métricas via `hcloud` CLI (server describe).

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use monitor_shared::{MetricRow, MetricSource, HOST_NAME};
use serde_json::Value;
use tokio::process::Command;
use tracing::warn;

/// Custo horário da VM em USD.
///
/// CX23 €4.59/mo + IPv4 €0.50/mo, conv ~1.07 USD/EUR, dividido por 730h ≈ 0.00766.
/// Atualizar se plano mudar.
const HOURLY_RATE_USD: f64 = 0.00766;

pub async fn collect(ts: DateTime<Utc>) -> Result<(Vec<MetricRow>, Vec<monitor_shared::ExternalMetric>)> {
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
    Ok((parse_metrics(ts, &value), external_metrics(ts, &value)))
}

/// Espelha o `cost_accumulated_usd` em `ExternalMetric` pra alimentar a
/// hypertable `external_metrics` que a aba "Custos" do launcher consulta.
/// Sprint B3. Quota = None (Hetzner não tem free tier).
pub fn external_metrics(ts: DateTime<Utc>, value: &serde_json::Value) -> Vec<monitor_shared::ExternalMetric> {
    let created_at = match parse_created_at(value) {
        Some(c) => c,
        None => return Vec::new(),
    };
    let raw_hours = (ts - created_at).num_seconds() as f64 / 3600.0;
    let hours = if raw_hours.is_finite() && raw_hours > 0.0 {
        raw_hours
    } else {
        0.0
    };
    let cost = hours * HOURLY_RATE_USD;

    vec![monitor_shared::ExternalMetric {
        ts,
        service: "hetzner".to_string(),
        metric: "cost_accumulated_usd".to_string(),
        value: cost,
        quota: None,
        unit: "usd".to_string(),
        period_start: None,
    }]
}

/// Extrai métricas a partir do JSON do `hcloud server describe`.
///
/// Separado de `collect()` pra ser testável sem depender do binário `hcloud`.
fn parse_metrics(ts: DateTime<Utc>, value: &Value) -> Vec<MetricRow> {
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

    // Custo acumulado + idade da VM, derivados de `created_at`.
    // Defensivo: se faltar ou não parsear, loga warn e segue só com as 4 métricas acima.
    match parse_created_at(value) {
        Some(created_at) => {
            let raw_hours = (ts - created_at).num_seconds() as f64 / 3600.0;
            // Clock skew → não dropar, emite 0.
            let hours_elapsed = if raw_hours.is_finite() && raw_hours > 0.0 {
                raw_hours
            } else {
                0.0
            };
            out.push(metric(ts, "vm_age_hours", hours_elapsed));
            out.push(metric(
                ts,
                "cost_accumulated_usd",
                hours_elapsed * HOURLY_RATE_USD,
            ));
        }
        None => {
            warn!("hetzner: created_at ausente ou inválido no JSON do hcloud, pulando cost/age");
        }
    }

    out
}

fn parse_created_at(value: &Value) -> Option<DateTime<Utc>> {
    let s = value.get("created")?.as_str()?;
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_iso_created_at() {
        let v = json!({ "created": "2026-05-06T00:00:00Z" });
        let parsed = parse_created_at(&v).expect("should parse");
        assert_eq!(
            parsed,
            DateTime::parse_from_rfc3339("2026-05-06T00:00:00Z")
                .unwrap()
                .with_timezone(&Utc)
        );
    }

    #[test]
    fn cost_calc_100h() {
        // 100h * HOURLY_RATE_USD ≈ 0.766
        let created = DateTime::parse_from_rfc3339("2026-05-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let ts = created + chrono::Duration::hours(100);
        let v = json!({
            "created": "2026-05-01T00:00:00Z",
            "status": "running",
        });
        let rows = parse_metrics(ts, &v);
        let cost = rows
            .iter()
            .find(|r| r.metric == "cost_accumulated_usd")
            .and_then(|r| r.value)
            .expect("cost emitted");
        assert!(
            (cost - 0.766).abs() < 1e-3,
            "expected ~0.766, got {cost}"
        );
        let age = rows
            .iter()
            .find(|r| r.metric == "vm_age_hours")
            .and_then(|r| r.value)
            .expect("age emitted");
        assert!((age - 100.0).abs() < 1e-9);
    }

    #[test]
    fn missing_created_at_keeps_existing_metrics() {
        let ts = Utc::now();
        let v = json!({
            "included_traffic": 1000.0,
            "outgoing_traffic": 500.0,
            "ingoing_traffic": 200.0,
            "status": "running",
            // sem `created`
        });
        let rows = parse_metrics(ts, &v);
        // 4 métricas existentes presentes
        assert!(rows.iter().any(|r| r.metric == "included_traffic_bytes"));
        assert!(rows.iter().any(|r| r.metric == "outgoing_traffic_bytes"));
        assert!(rows.iter().any(|r| r.metric == "ingoing_traffic_bytes"));
        assert!(rows.iter().any(|r| r.metric == "status_running"));
        // E nada de cost/age
        assert!(rows.iter().all(|r| r.metric != "cost_accumulated_usd"));
        assert!(rows.iter().all(|r| r.metric != "vm_age_hours"));
        assert_eq!(rows.len(), 4);
    }

    #[test]
    fn unparseable_created_at_skips_cost_metrics() {
        let ts = Utc::now();
        let v = json!({
            "status": "running",
            "created": "not-a-date",
        });
        let rows = parse_metrics(ts, &v);
        assert!(rows.iter().any(|r| r.metric == "status_running"));
        assert!(rows.iter().all(|r| r.metric != "cost_accumulated_usd"));
        assert!(rows.iter().all(|r| r.metric != "vm_age_hours"));
    }

    #[test]
    fn external_metrics_emits_cost_row() {
        let created = DateTime::parse_from_rfc3339("2026-05-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let ts = created + chrono::Duration::hours(100);
        let v = json!({ "created": "2026-05-01T00:00:00Z", "status": "running" });

        let rows = external_metrics(ts, &v);
        assert_eq!(rows.len(), 1);
        let m = &rows[0];
        assert_eq!(m.service, "hetzner");
        assert_eq!(m.metric, "cost_accumulated_usd");
        assert_eq!(m.unit, "usd");
        assert_eq!(m.quota, None);
        assert!((m.value - 0.766).abs() < 1e-3);
    }

    #[test]
    fn external_metrics_skips_when_no_created_at() {
        let v = json!({ "status": "running" });
        assert!(external_metrics(Utc::now(), &v).is_empty());
    }

    #[test]
    fn negative_hours_emits_zero() {
        // ts < created (clock skew) → emite 0, não dropa
        let created = DateTime::parse_from_rfc3339("2026-05-10T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let ts = created - chrono::Duration::hours(5);
        let v = json!({
            "created": "2026-05-10T00:00:00Z",
        });
        let rows = parse_metrics(ts, &v);
        let age = rows
            .iter()
            .find(|r| r.metric == "vm_age_hours")
            .and_then(|r| r.value)
            .expect("age still emitted");
        assert_eq!(age, 0.0);
        let cost = rows
            .iter()
            .find(|r| r.metric == "cost_accumulated_usd")
            .and_then(|r| r.value)
            .expect("cost still emitted");
        assert_eq!(cost, 0.0);
    }
}
