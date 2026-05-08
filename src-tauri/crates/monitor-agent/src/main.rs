mod buffer;
mod collectors;
mod db;

use anyhow::{Context, Result};
use buffer::Buffer;
use chrono::Utc;
use collectors::vm::VmCollectorState;
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

    // Vercel collector — task paralela com poll 5min (rate limit ~100req/h).
    // Token ausente → degrada gracefully: agente segue normal sem coletor Vercel.
    let vercel_token = std::env::var("VERCEL_TOKEN").ok();
    if vercel_token.is_some() {
        tracing::info!("vercel: token presente — coletor habilitado");
    } else {
        tracing::warn!("vercel: VERCEL_TOKEN ausente — coletor desabilitado");
    }
    if let Some(token) = vercel_token {
        let pool_clone = pool.clone();
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .context("build reqwest client")?;
        tokio::spawn(async move {
            let mut tick = interval(Duration::from_secs(300));
            tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
            loop {
                // primeiro tick é imediato — força coleta inicial sem esperar 5min
                tick.tick().await;
                let ts = Utc::now();
                match collectors::vercel::collect(ts, &http, &token).await {
                    Ok(rows) => {
                        if rows.is_empty() {
                            tracing::debug!("vercel: nenhum deployment retornado");
                            continue;
                        }
                        let count = rows.len();
                        match db::insert_vercel_deployments(&pool_clone, &rows).await {
                            Ok(()) => tracing::info!(rows = count, "vercel: persisted deployments"),
                            Err(e) => tracing::warn!("vercel: insert failed: {e:#}"),
                        }
                    }
                    Err(e) => tracing::warn!("vercel: collect failed: {e:#}"),
                }
            }
        });
    }

    // Vercel /v1/usage — tick 1h, alimenta external_metrics (aba Custos).
    if let Ok(token) = std::env::var("VERCEL_TOKEN") {
        let pool_clone = pool.clone();
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .context("build reqwest client (vercel_usage)")?;
        tokio::spawn(async move {
            let mut tick = interval(Duration::from_secs(3600));
            tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                let ts = Utc::now();
                match collectors::vercel_usage::collect(ts, &http, &token).await {
                    Ok(rows) => {
                        if rows.is_empty() {
                            tracing::debug!("vercel_usage: nenhuma métrica retornada");
                            continue;
                        }
                        let count = rows.len();
                        match db::insert_external_metrics(&pool_clone, &rows).await {
                            Ok(()) => tracing::info!(rows = count, "vercel_usage: persisted"),
                            Err(e) => tracing::warn!("vercel_usage: insert failed: {e:#}"),
                        }
                    }
                    Err(e) => tracing::warn!("vercel_usage: collect failed: {e:#}"),
                }
            }
        });
    }

    // GitHub Actions billing — tick 1h, alimenta external_metrics.
    if let Ok(token) = std::env::var("GH_PAT_SECURITY") {
        let user = std::env::var("GH_BILLING_USER").unwrap_or_else(|_| "Falkzera".to_string());
        let pool_clone = pool.clone();
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .context("build reqwest client (gh_actions)")?;
        tokio::spawn(async move {
            let mut tick = interval(Duration::from_secs(3600));
            tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                let ts = Utc::now();
                match collectors::gh_actions::collect(ts, &http, &token, &user).await {
                    Ok(rows) => {
                        if rows.is_empty() {
                            tracing::debug!("gh_actions: nenhuma métrica retornada");
                            continue;
                        }
                        let count = rows.len();
                        match db::insert_external_metrics(&pool_clone, &rows).await {
                            Ok(()) => tracing::info!(rows = count, "gh_actions: persisted"),
                            Err(e) => tracing::warn!("gh_actions: insert failed: {e:#}"),
                        }
                    }
                    Err(e) => tracing::warn!("gh_actions: collect failed: {e:#}"),
                }
            }
        });
    } else {
        tracing::warn!("gh_actions: GH_PAT_SECURITY ausente — coletor desabilitado");
    }

    let mut buf = Buffer::default();
    let mut vm_state = VmCollectorState::default();

    let mut tick = interval(Duration::from_secs(POLL_INTERVAL_SECS));
    tick.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        tick.tick().await;
        let ts = Utc::now();
        let mut batch = Vec::new();

        // vm::collect agora é cheap (sem sleep), então rodamos primeiro pra
        // segurar o &mut vm_state, e depois disparamos os dois pesados em
        // paralelo. Ordem importa pra precisão do cpu_pct: a leitura de
        // /proc/stat acontece ANTES de docker stats e hcloud queimarem CPU.
        let vm_res = collectors::vm::collect(ts, &mut vm_state).await;
        let (ctr_res, hz_res) = tokio::join!(
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
            Ok((mut rows, ext_rows)) => {
                batch.append(&mut rows);
                if !ext_rows.is_empty() {
                    if let Err(e) = db::insert_external_metrics(&pool, &ext_rows).await {
                        tracing::warn!("hetzner: insert external_metrics failed: {e:#}");
                    }
                }
            }
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
