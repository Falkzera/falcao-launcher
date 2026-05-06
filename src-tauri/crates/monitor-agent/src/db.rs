use anyhow::{Context, Result};
use deadpool_postgres::Pool;
use monitor_shared::MetricRow;
use tokio_postgres::NoTls;

pub fn build_pool(database_url: &str) -> Result<Pool> {
    let parsed: tokio_postgres::Config = database_url
        .parse()
        .context("invalid DATABASE_URL")?;

    let pool = deadpool_postgres::Pool::builder(deadpool_postgres::Manager::new(parsed, NoTls))
        .max_size(4)
        .build()
        .context("failed to build connection pool")?;
    Ok(pool)
}

pub async fn insert_batch(pool: &Pool, rows: &[MetricRow]) -> Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let client = pool.get().await.context("get pool client")?;
    let stmt = client
        .prepare(
            "INSERT INTO metrics (ts, host, source, resource, metric, value, labels)
             VALUES ($1, $2, $3, $4, $5, $6, $7)",
        )
        .await
        .context("prepare insert")?;

    for r in rows {
        let source_str = r.source.as_str();
        client
            .execute(
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
        let pool = build_pool(&url).expect("build pool");

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
