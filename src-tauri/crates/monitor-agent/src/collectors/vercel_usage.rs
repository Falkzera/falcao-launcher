//! Coletor Vercel /v1/usage — bandwidth + build minutes + image opt + functions.
//! Sprint B3. Tick 1h (rate limit folgado).

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use monitor_shared::ExternalMetric;
use reqwest::Client;
use serde_json::Value;

const API_BASE: &str = "https://api.vercel.com";
const SERVICE: &str = "vercel";

pub async fn collect(
    ts: DateTime<Utc>,
    client: &Client,
    token: &str,
) -> Result<Vec<ExternalMetric>> {
    let resp = client
        .get(format!("{API_BASE}/v1/usage"))
        .bearer_auth(token)
        .send()
        .await
        .context("GET /v1/usage")?;
    let body: Value = resp
        .error_for_status()
        .context("/v1/usage status")?
        .json()
        .await
        .context("parse /v1/usage body")?;
    Ok(parse_usage(ts, &body))
}

/// Parser puro pra ser testável sem HTTP.
fn parse_usage(ts: DateTime<Utc>, body: &Value) -> Vec<ExternalMetric> {
    let period_start = body
        .get("billingPeriod")
        .and_then(|p| p.get("start"))
        .and_then(Value::as_str)
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.with_timezone(&Utc));

    let mut out = Vec::with_capacity(4);
    let usage = match body.get("usage") {
        Some(u) => u,
        None => return out,
    };

    push(&mut out, ts, period_start, usage, "bandwidth", "bandwidth_bytes", "bytes");
    push(&mut out, ts, period_start, usage, "buildMinutes", "build_minutes", "minutes");
    push(&mut out, ts, period_start, usage, "imageOptimizations", "image_optimization_count", "count");
    push(&mut out, ts, period_start, usage, "serverlessFunctionExecution", "function_invocations", "count");

    out
}

fn push(
    out: &mut Vec<ExternalMetric>,
    ts: DateTime<Utc>,
    period_start: Option<DateTime<Utc>>,
    usage: &Value,
    api_field: &str,
    metric_name: &str,
    unit: &str,
) {
    let entry = match usage.get(api_field) {
        Some(e) => e,
        None => return,
    };
    let value = match entry.get("usage").and_then(Value::as_f64) {
        Some(v) => v,
        None => return,
    };
    let quota = entry.get("limit").and_then(Value::as_f64);
    out.push(ExternalMetric {
        ts,
        service: SERVICE.to_string(),
        metric: metric_name.to_string(),
        value,
        quota,
        unit: unit.to_string(),
        period_start,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../tests/fixtures/vercel_usage_sample.json");

    #[test]
    fn parses_full_fixture() {
        let body: Value = serde_json::from_str(FIXTURE).expect("valid fixture json");
        let ts = Utc::now();
        let out = parse_usage(ts, &body);
        assert_eq!(out.len(), 4, "expected 4 metrics, got {}", out.len());

        let bw = out.iter().find(|m| m.metric == "bandwidth_bytes").expect("bandwidth");
        assert_eq!(bw.value, 12884901888.0);
        assert_eq!(bw.quota, Some(107374182400.0));
        assert_eq!(bw.unit, "bytes");
        assert_eq!(bw.service, "vercel");
        assert!(bw.period_start.is_some());

        let bm = out.iter().find(|m| m.metric == "build_minutes").expect("build");
        assert_eq!(bm.value, 134.0);
        assert_eq!(bm.quota, Some(6000.0));
    }

    #[test]
    fn missing_usage_returns_empty() {
        let body: Value = serde_json::json!({ "billingPeriod": { "start": "2026-05-01T00:00:00Z" } });
        let out = parse_usage(Utc::now(), &body);
        assert!(out.is_empty());
    }

    #[test]
    fn missing_field_skips_metric_only() {
        let body: Value = serde_json::json!({
            "usage": {
                "bandwidth": { "usage": 100, "limit": 1000 }
            }
        });
        let out = parse_usage(Utc::now(), &body);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].metric, "bandwidth_bytes");
    }

    #[test]
    fn missing_limit_is_quota_none() {
        let body: Value = serde_json::json!({
            "usage": {
                "bandwidth": { "usage": 100 }
            }
        });
        let out = parse_usage(Utc::now(), &body);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].quota, None);
        assert_eq!(out[0].value, 100.0);
    }
}
