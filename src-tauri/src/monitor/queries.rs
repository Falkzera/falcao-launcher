//! Queries SQL pro Postgres da VM (read-only via monitor_reader).

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use deadpool_postgres::Pool;
use serde::Serialize;
use tokio_postgres::NoTls;

#[derive(Debug, Serialize)]
pub struct MetricPoint {
    pub ts: DateTime<Utc>,
    pub value: Option<f64>,
}

pub fn build_pool(database_url: &str) -> Result<Pool> {
    let parsed: tokio_postgres::Config = database_url.parse().context("invalid DATABASE_URL")?;
    deadpool_postgres::Pool::builder(deadpool_postgres::Manager::new(parsed, NoTls))
        .max_size(2)
        .build()
        .context("build pool")
}

pub async fn fetch_metric_series(
    pool: &Pool,
    source: &str,
    resource: Option<&str>,
    metric: &str,
    since: DateTime<Utc>,
    until: Option<DateTime<Utc>>,
    bucket: Option<&str>, // '1 minute' | '1 hour' | '1 day' | None (raw)
) -> Result<Vec<MetricPoint>> {
    // Whitelist allowed bucket values (TimescaleDB time_bucket interval)
    if let Some(b) = bucket {
        match b {
            "1 minute" | "5 minutes" | "1 hour" | "1 day" => {}
            _ => return Err(anyhow::anyhow!("invalid bucket: {b}")),
        }
    }

    let client = pool.get().await?;
    let until_v = until.unwrap_or_else(Utc::now);

    let rows = if let Some(b) = bucket {
        let sql = format!(
            "SELECT time_bucket('{}', ts) AS bucket, avg(value) FROM metrics
             WHERE source = $1 AND ($2::text IS NULL OR resource = $2)
                   AND metric = $3 AND ts BETWEEN $4 AND $5
             GROUP BY bucket ORDER BY bucket",
            b
        );
        client
            .query(&sql, &[&source, &resource, &metric, &since, &until_v])
            .await
            .context("query bucketed")?
    } else {
        client
            .query(
                "SELECT ts, value FROM metrics
                 WHERE source = $1 AND ($2::text IS NULL OR resource = $2)
                       AND metric = $3 AND ts BETWEEN $4 AND $5
                 ORDER BY ts",
                &[&source, &resource, &metric, &since, &until_v],
            )
            .await
            .context("query raw")?
    };

    let points = rows
        .into_iter()
        .map(|r| MetricPoint {
            ts: r.get(0),
            value: r.get(1),
        })
        .collect();
    Ok(points)
}

#[derive(Debug, Serialize)]
pub struct ContainerInfo {
    pub name: String,
    pub last_cpu_pct: Option<f64>,
    pub last_mem_pct: Option<f64>,
    pub last_seen: Option<DateTime<Utc>>,
    pub last_mem_used_bytes: Option<f64>,
    pub last_mem_limit_bytes: Option<f64>,
}

pub async fn list_containers(pool: &Pool) -> Result<Vec<ContainerInfo>> {
    let client = pool.get().await?;
    let rows = client
        .query(
            r#"
            WITH latest AS (
              SELECT DISTINCT ON (resource, metric)
                resource, metric, value, ts
              FROM metrics
              WHERE source = 'container'
                AND metric IN ('cpu_pct', 'mem_pct', 'mem_used_bytes', 'mem_limit_bytes')
                AND ts > NOW() - INTERVAL '5 minutes'
              ORDER BY resource, metric, ts DESC
            )
            SELECT
              resource AS name,
              MAX(CASE WHEN metric = 'cpu_pct' THEN value END) AS cpu_pct,
              MAX(CASE WHEN metric = 'mem_pct' THEN value END) AS mem_pct,
              MAX(ts) AS last_seen,
              MAX(CASE WHEN metric = 'mem_used_bytes' THEN value END) AS mem_used_bytes,
              MAX(CASE WHEN metric = 'mem_limit_bytes' THEN value END) AS mem_limit_bytes
            FROM latest
            GROUP BY resource
            ORDER BY resource
            "#,
            &[],
        )
        .await
        .context("list containers")?;

    Ok(rows
        .into_iter()
        .map(|r| ContainerInfo {
            name: r.get(0),
            last_cpu_pct: r.get(1),
            last_mem_pct: r.get(2),
            last_seen: r.get(3),
            last_mem_used_bytes: r.get(4),
            last_mem_limit_bytes: r.get(5),
        })
        .collect())
}

#[derive(Debug, Serialize)]
pub struct VmStatus {
    pub last_heartbeat: Option<DateTime<Utc>>,
    pub agent_version: Option<String>,
    pub last_cpu_pct: Option<f64>,
    pub last_mem_pct: Option<f64>,
    pub last_mem_used_bytes: Option<f64>,
    pub last_mem_total_bytes: Option<f64>,
    pub last_disk_used_bytes: Option<f64>,
    pub last_disk_avail_bytes: Option<f64>,
    pub last_hetzner_outgoing_bytes: Option<f64>,
    pub last_hetzner_included_bytes: Option<f64>,
    pub cost_accumulated_usd: Option<f64>,
    pub vm_age_hours: Option<f64>,
}

/// Helper: pega o último valor de uma métrica `(source, metric)` (sem resource).
async fn latest_metric(
    client: &deadpool_postgres::Client,
    source: &str,
    metric: &str,
) -> Result<Option<f64>> {
    let row = client
        .query_opt(
            "SELECT value FROM metrics WHERE source = $1 AND metric = $2
             ORDER BY ts DESC LIMIT 1",
            &[&source, &metric],
        )
        .await
        .with_context(|| format!("latest_metric({source},{metric})"))?;
    Ok(row.and_then(|r| r.get::<_, Option<f64>>(0)))
}

pub async fn vm_status(pool: &Pool) -> Result<VmStatus> {
    let client = pool.get().await?;
    let row = client
        .query_opt(
            "SELECT last_seen, agent_version FROM agent_heartbeat WHERE host = 'falcao-main'",
            &[],
        )
        .await?;
    let (last_heartbeat, agent_version) = match row {
        Some(r) => (Some(r.get(0)), Some(r.get(1))),
        None => (None, None),
    };

    let cpu = latest_metric(&client, "vm", "load_1m").await?;
    let mem_used = latest_metric(&client, "vm", "mem_used_bytes").await?;
    let mem_total = latest_metric(&client, "vm", "mem_total_bytes").await?;
    let disk_used = latest_metric(&client, "vm", "disk_used_bytes").await?;
    let disk_avail = latest_metric(&client, "vm", "disk_avail_bytes").await?;
    let hetzner_outgoing = latest_metric(&client, "hetzner", "outgoing_traffic_bytes").await?;
    let hetzner_included = latest_metric(&client, "hetzner", "included_traffic_bytes").await?;
    let cost_accumulated = latest_metric(&client, "hetzner", "cost_accumulated_usd").await?;
    let vm_age_hours = latest_metric(&client, "hetzner", "vm_age_hours").await?;

    let mem_pct = mem_used
        .zip(mem_total)
        .map(|(used, total)| if total > 0.0 { 100.0 * used / total } else { 0.0 });

    Ok(VmStatus {
        last_heartbeat,
        agent_version,
        last_cpu_pct: cpu,
        last_mem_pct: mem_pct,
        last_mem_used_bytes: mem_used,
        last_mem_total_bytes: mem_total,
        last_disk_used_bytes: disk_used,
        last_disk_avail_bytes: disk_avail,
        last_hetzner_outgoing_bytes: hetzner_outgoing,
        last_hetzner_included_bytes: hetzner_included,
        cost_accumulated_usd: cost_accumulated,
        vm_age_hours,
    })
}
