mod buffer;
mod collectors;
mod db;

use anyhow::{Context, Result};
use buffer::Buffer;
use chrono::Utc;
use monitor_shared::{HOST_NAME, POLL_INTERVAL_SECS};
use std::time::Duration;
use tokio::time::{interval, MissedTickBehavior};

const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    // Lê DATABASE_URL e converte imediatamente em tokio_postgres::Config
    // pra que o string original (com password) saia de scope. Display de Config
    // não inclui password, então nenhum erro logado vaza credencial.
    let database_url = std::env::var("DATABASE_URL").context("DATABASE_URL not set")?;
    let cfg: tokio_postgres::Config = database_url
        .parse()
        .context("invalid DATABASE_URL format")?;
    drop(database_url);
    let pool = db::build_pool(cfg)?;

    tracing::info!(version = AGENT_VERSION, "falcao-monitor-agent starting");

    let mut buf = Buffer::default();

    let mut tick = interval(Duration::from_secs(POLL_INTERVAL_SECS));
    tick.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        tick.tick().await;
        let ts = Utc::now();
        let mut batch = Vec::new();

        // Coletores rodam em paralelo — latência do ciclo é a do mais lento (~800ms)
        // ao invés da soma sequencial (~1-2s).
        let (vm_res, ctr_res, hz_res) = tokio::join!(
            collectors::vm::collect(ts),
            collectors::container::collect(ts),
            collectors::hetzner::collect(ts),
        );

        match vm_res {
            Ok(mut rows) => batch.append(&mut rows),
            Err(e) => tracing::warn!("vm collector failed: {e:#}"),
        }
        match ctr_res {
            Ok(mut rows) => batch.append(&mut rows),
            Err(e) => tracing::warn!("container collector failed: {e:#}"),
        }
        match hz_res {
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
                if let Err(e) = db::write_heartbeat(&pool, HOST_NAME, AGENT_VERSION).await {
                    tracing::warn!("heartbeat write failed: {e:#}");
                }
            }
            Err(e) => {
                tracing::warn!(rows = count, "DB write failed, re-buffering: {e:#}");
                buf.push_batch(pending);
            }
        }

        if buf.dropped_count() > 0 {
            tracing::warn!(dropped = buf.dropped_count(), "buffer overflow occurred");
        }
    }
}
