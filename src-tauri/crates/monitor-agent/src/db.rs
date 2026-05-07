use anyhow::{Context, Result};
use deadpool_postgres::Pool;
use monitor_shared::{MetricRow, VercelDeployment};
use tokio_postgres::NoTls;

pub fn build_pool(cfg: tokio_postgres::Config) -> Result<Pool> {
    let pool = deadpool_postgres::Pool::builder(deadpool_postgres::Manager::new(cfg, NoTls))
        .max_size(4)
        .build()
        .context("failed to build connection pool")?;
    Ok(pool)
}

pub async fn insert_batch(pool: &Pool, rows: &[MetricRow]) -> Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let mut client = pool.get().await.context("get pool client")?;
    let tx = client.transaction().await.context("begin tx")?;
    let stmt = tx
        .prepare(
            "INSERT INTO metrics (ts, host, source, resource, metric, value, labels)
             VALUES ($1, $2, $3, $4, $5, $6, $7)",
        )
        .await
        .context("prepare insert")?;

    for r in rows {
        let source_str = r.source.as_str();
        tx.execute(
            &stmt,
            &[
                &r.ts,
                &r.host,
                &source_str,
                &r.resource,
                &r.metric,
                &r.value,
                &r.labels,
            ],
        )
        .await
        .context("execute insert")?;
    }
    tx.commit().await.context("commit tx")?;
    Ok(())
}

/// INSERT batch transacional pra `vercel_deployments`.
/// Sprint 2 — uma row por projeto por tick (poll 5min). Sem ON CONFLICT:
/// queremos histórico de observações (mesmo deploy aparece em vários ticks
/// enquanto ainda é o "último"). Query-time pega `ORDER BY ts DESC LIMIT 1`.
pub async fn insert_vercel_deployments(
    pool: &Pool,
    rows: &[VercelDeployment],
) -> Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let mut client = pool.get().await.context("get pool client")?;
    let tx = client.transaction().await.context("begin tx")?;
    let stmt = tx
        .prepare(
            "INSERT INTO vercel_deployments
             (ts, project_id, project_name, deployment_id, state, url, prod_url,
              branch, commit_sha, commit_msg, author, created_at, ready_at, build_ms)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)",
        )
        .await
        .context("prepare insert vercel_deployments")?;

    for r in rows {
        tx.execute(
            &stmt,
            &[
                &r.ts,
                &r.project_id,
                &r.project_name,
                &r.deployment_id,
                &r.state,
                &r.url,
                &r.prod_url,
                &r.branch,
                &r.commit_sha,
                &r.commit_msg,
                &r.author,
                &r.created_at,
                &r.ready_at,
                &r.build_ms,
            ],
        )
        .await
        .context("execute insert vercel_deployments")?;
    }
    tx.commit().await.context("commit vercel tx")?;
    Ok(())
}

pub async fn write_heartbeat(pool: &Pool, host: &str, version: &str) -> Result<()> {
    let client = pool.get().await?;
    client
        .execute(
            "INSERT INTO agent_heartbeat (host, last_seen, agent_version)
             VALUES ($1, NOW(), $2)
             ON CONFLICT (host) DO UPDATE
               SET last_seen = NOW(), agent_version = EXCLUDED.agent_version",
            &[&host, &version],
        )
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use monitor_shared::MetricSource;

    #[tokio::test]
    #[ignore] // requer DATABASE_URL_TEST setado
    async fn insert_and_read_back() {
        let url = std::env::var("DATABASE_URL_TEST")
            .expect("DATABASE_URL_TEST required");
        let cfg: tokio_postgres::Config = url.parse().expect("parse url");
        let pool = build_pool(cfg).expect("build pool");

        let row = MetricRow {
            ts: Utc::now(),
            host: format!("test-{}", chrono::Utc::now().timestamp_nanos_opt().unwrap()),
            source: MetricSource::Vm,
            resource: None,
            metric: "cpu_pct".to_string(),
            value: Some(42.0),
            labels: None,
        };

        insert_batch(&pool, std::slice::from_ref(&row)).await.expect("insert");

        let client = pool.get().await.expect("client");
        let r = client.query_one(
            "SELECT value FROM metrics WHERE host = $1 AND metric = 'cpu_pct' LIMIT 1",
            &[&row.host],
        ).await.expect("read back");
        let v: f64 = r.get(0);
        assert_eq!(v, 42.0);

        client.execute("DELETE FROM metrics WHERE host = $1", &[&row.host]).await.ok();
    }
}
