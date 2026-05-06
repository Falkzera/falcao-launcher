mod buffer;
mod collectors;
mod db;

use anyhow::{Context, Result};
use buffer::Buffer;
use chrono::Utc;
use monitor_shared::{HOST_NAME, POLL_INTERVAL_SECS};
use std::time::Duration;
use tokio::time::sleep;

const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let database_url = std::env::var("DATABASE_URL").context("DATABASE_URL not set")?;
    let pool = db::build_pool(&database_url)?;

    tracing::info!(version = AGENT_VERSION, "falcao-monitor-agent starting");

    let mut buf = Buffer::default();

    loop {
        let ts = Utc::now();
        let mut batch = Vec::new();

        match collectors::vm::collect(ts).await {
            Ok(mut rows) => batch.append(&mut rows),
            Err(e) => tracing::warn!("vm collector failed: {e:#}"),
        }
        match collectors::container::collect(ts).await {
            Ok(mut rows) => batch.append(&mut rows),
            Err(e) => tracing::warn!("container collector failed: {e:#}"),
        }
        match collectors::hetzner::collect(ts).await {
            Ok(mut rows) => batch.append(&mut rows),
            Err(e) => tracing::warn!("hetzner collector failed: {e:#}"),
        }

        // Tenta flush do buffer + batch novo
        buf.push_batch(batch);
        let pending = buf.drain_all();
        let count = pending.len();

        match db::insert_batch(&pool, &pending).await {
            Ok(()) => {
                tracing::debug!(rows = count, "flushed batch");
                let _ = db::write_heartbeat(&pool, HOST_NAME, AGENT_VERSION).await;
            }
            Err(e) => {
                tracing::warn!(rows = count, "DB write failed, re-buffering: {e:#}");
                buf.push_batch(pending);
            }
        }

        if buf.dropped_count() > 0 {
            tracing::warn!(dropped = buf.dropped_count(), "buffer overflow occurred");
        }

        sleep(Duration::from_secs(POLL_INTERVAL_SECS)).await;
    }
}
