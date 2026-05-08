//! Coletor GitHub Actions billing.
//! GET /users/{user}/settings/billing/actions com PAT.

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use monitor_shared::ExternalMetric;
use reqwest::Client;
use serde_json::Value;

const API_BASE: &str = "https://api.github.com";
const SERVICE: &str = "gh_actions";

pub async fn collect(
    ts: DateTime<Utc>,
    client: &Client,
    token: &str,
    user: &str,
) -> Result<Vec<ExternalMetric>> {
    let url = format!("{API_BASE}/users/{user}/settings/billing/actions");
    let resp = client
        .get(&url)
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "falcao-monitor-agent")
        .send()
        .await
        .context("GET billing/actions")?;
    let body: Value = resp
        .error_for_status()
        .context("billing/actions status")?
        .json()
        .await
        .context("parse billing/actions body")?;
    Ok(parse_billing(ts, &body))
}

fn parse_billing(ts: DateTime<Utc>, body: &Value) -> Vec<ExternalMetric> {
    let used = match body.get("total_minutes_used").and_then(Value::as_f64) {
        Some(v) => v,
        None => return Vec::new(),
    };
    let included = body.get("included_minutes").and_then(Value::as_f64);

    vec![ExternalMetric {
        ts,
        service: SERVICE.to_string(),
        metric: "minutes_used".to_string(),
        value: used,
        quota: included,
        unit: "minutes".to_string(),
        period_start: None,
    }]
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../tests/fixtures/gh_actions_sample.json");

    #[test]
    fn parses_full_fixture() {
        let body: Value = serde_json::from_str(FIXTURE).expect("valid fixture");
        let out = parse_billing(Utc::now(), &body);
        assert_eq!(out.len(), 1);
        let m = &out[0];
        assert_eq!(m.service, "gh_actions");
        assert_eq!(m.metric, "minutes_used");
        assert_eq!(m.value, 87.0);
        assert_eq!(m.quota, Some(2000.0));
        assert_eq!(m.unit, "minutes");
    }

    #[test]
    fn missing_used_returns_empty() {
        let body: Value = serde_json::json!({ "included_minutes": 2000 });
        let out = parse_billing(Utc::now(), &body);
        assert!(out.is_empty());
    }

    #[test]
    fn missing_included_is_quota_none() {
        let body: Value = serde_json::json!({ "total_minutes_used": 50 });
        let out = parse_billing(Utc::now(), &body);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].quota, None);
    }
}
