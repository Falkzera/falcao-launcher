//! Queries SELECT pra hypertable `external_metrics` (Sprint B3).
//!
//! `cost_summary` retorna a última amostra por (service, metric) — DISTINCT ON.
//! `cost_history` retorna série temporal pra um (service, metric) específico
//! dentro de um range bounded (max 90 dias, mesmo retention da hypertable).

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use deadpool_postgres::Pool;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct CostUsage {
    pub service: String,
    pub metric: String,
    pub value: f64,
    pub quota: Option<f64>,
    pub unit: String,
    pub pct: Option<f64>, // value/quota * 100, None se quota é None
    pub period_start: Option<DateTime<Utc>>,
    pub ts: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CostHistoryPoint {
    pub ts: DateTime<Utc>,
    pub value: f64,
}

const VALID_SERVICES: &[&str] = &["vercel", "gh_actions", "hetzner"];
const VALID_METRICS: &[&str] = &[
    "bandwidth_bytes",
    "build_minutes",
    "image_optimization_count",
    "function_invocations",
    "minutes_used",
    "cost_accumulated_usd",
];

pub async fn cost_summary(pool: &Pool) -> Result<Vec<CostUsage>> {
    let client = pool.get().await.context("get client")?;
    let rows = client
        .query(
            r#"
            SELECT DISTINCT ON (service, metric)
              service, metric, value, quota, unit, period_start, ts
            FROM external_metrics
            WHERE ts > now() - interval '24 hours'
            ORDER BY service, metric, ts DESC
            "#,
            &[],
        )
        .await
        .context("query cost_summary")?;

    Ok(rows
        .into_iter()
        .map(|r| {
            let value: f64 = r.get(2);
            let quota: Option<f64> = r.get(3);
            let pct = quota.map(|q| if q > 0.0 { (value / q) * 100.0 } else { 0.0 });
            CostUsage {
                service: r.get(0),
                metric: r.get(1),
                value,
                quota,
                unit: r.get(4),
                pct,
                period_start: r.get(5),
                ts: r.get(6),
            }
        })
        .collect())
}

pub async fn cost_history(
    pool: &Pool,
    service: &str,
    metric: &str,
    since: DateTime<Utc>,
    until: DateTime<Utc>,
) -> Result<Vec<CostHistoryPoint>> {
    if !VALID_SERVICES.contains(&service) {
        anyhow::bail!("invalid service: {service}");
    }
    if !VALID_METRICS.contains(&metric) {
        anyhow::bail!("invalid metric: {metric}");
    }
    if until <= since {
        anyhow::bail!("until must be > since");
    }
    let max_range = chrono::Duration::days(90);
    if until - since > max_range {
        anyhow::bail!("range max é 90 dias");
    }

    let client = pool.get().await.context("get client")?;
    let rows = client
        .query(
            r#"
            SELECT ts, value
            FROM external_metrics
            WHERE service = $1
              AND metric  = $2
              AND ts >= $3
              AND ts <= $4
            ORDER BY ts ASC
            "#,
            &[&service, &metric, &since, &until],
        )
        .await
        .context("query cost_history")?;

    Ok(rows
        .into_iter()
        .map(|r| CostHistoryPoint {
            ts: r.get(0),
            value: r.get(1),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_pool() -> Pool {
        let cfg: tokio_postgres::Config = "host=127.0.0.1 user=x password=y dbname=z"
            .parse()
            .expect("parse cfg");
        deadpool_postgres::Pool::builder(deadpool_postgres::Manager::new(
            cfg,
            tokio_postgres::NoTls,
        ))
        .max_size(1)
        .build()
        .expect("build pool")
    }

    #[tokio::test]
    async fn rejects_unknown_service() {
        let pool = dummy_pool();
        let now = Utc::now();
        let err = cost_history(
            &pool,
            "invalid",
            "minutes_used",
            now,
            now + chrono::Duration::hours(1),
        )
        .await
        .expect_err("should fail");
        assert!(err.to_string().contains("invalid service"));
    }

    #[tokio::test]
    async fn rejects_range_over_90_days() {
        let pool = dummy_pool();
        let now = Utc::now();
        let err = cost_history(
            &pool,
            "vercel",
            "bandwidth_bytes",
            now - chrono::Duration::days(91),
            now,
        )
        .await
        .expect_err("should fail");
        assert!(err.to_string().contains("90 dias"));
    }
}
