//! Queries SQL pras "Stacks em produção" (Sprint 2 — Vercel stacks).
//!
//! Stack = agrupamento de frontend Vercel + backend container que dividem
//! o mesmo nome (label `monitor.stack=<nome>` no docker-compose iguala
//! ao `project_name` da Vercel). Inferência feita em query-time —
//! tabelas `metrics` e `vercel_deployments` são desacopladas.

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use deadpool_postgres::Pool;
use serde::Serialize;

use crate::monitor::queries::{ContainerInfo, HealthCheckSummary, fetch_health_summary};

#[derive(Debug, Serialize)]
pub struct StackSummary {
    pub name: String,
    pub vercel_state: Option<String>,
    pub backend_running: bool,
    pub container_names: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct VercelDeploymentRow {
    pub project_name: String,
    pub state: String,
    pub url: Option<String>,
    pub prod_url: Option<String>,
    pub branch: Option<String>,
    pub commit_msg: Option<String>,
    pub author: Option<String>,
    pub created_at: Option<DateTime<Utc>>,
    pub ready_at: Option<DateTime<Utc>>,
    pub build_ms: Option<i32>,
}

#[derive(Debug, Serialize)]
pub struct StackDetail {
    pub name: String,
    pub vercel: Option<VercelDeploymentRow>,
    pub containers: Vec<ContainerInfo>,
    pub endpoint_health: Option<HealthCheckSummary>,
}

/// Lista todas as stacks vivas (com container ativo OU deploy Vercel recente).
///
/// Pra cada stack retornada inclui:
/// - último `state` Vercel (se houver deploy nas últimas 24h)
/// - bool `backend_running` se algum container com a label foi visto nos últimos 5min
/// - lista de container names que compõem a stack (pra UI filtrar do grid cru)
pub async fn list_stacks(pool: &Pool) -> Result<Vec<StackSummary>> {
    let client = pool.get().await?;

    // 1) União de nomes vindos das duas fontes
    let names_rows = client
        .query(
            r#"
            WITH from_containers AS (
              SELECT DISTINCT labels->>'stack' AS name
              FROM metrics
              WHERE source = 'container'
                AND ts > now() - interval '5 minutes'
                AND labels ? 'stack'
            ),
            from_vercel AS (
              SELECT DISTINCT project_name AS name
              FROM vercel_deployments
              WHERE ts > now() - interval '24 hours'
            )
            SELECT name FROM from_containers
            UNION
            SELECT name FROM from_vercel
            ORDER BY name
            "#,
            &[],
        )
        .await
        .context("list stack names")?;

    let names: Vec<String> = names_rows
        .into_iter()
        .filter_map(|r| r.get::<_, Option<String>>(0))
        .filter(|s| !s.is_empty())
        .collect();

    if names.is_empty() {
        return Ok(Vec::new());
    }

    let mut out = Vec::with_capacity(names.len());
    for name in names {
        // Último state Vercel (se houver)
        let vercel_state: Option<String> = client
            .query_opt(
                "SELECT state FROM vercel_deployments
                 WHERE project_name = $1
                 ORDER BY ts DESC LIMIT 1",
                &[&name],
            )
            .await
            .context("latest vercel state")?
            .map(|r| r.get::<_, String>(0));

        // Containers ativos com a label, últimos 5 min
        let container_rows = client
            .query(
                "SELECT DISTINCT resource FROM metrics
                 WHERE source = 'container'
                   AND ts > now() - interval '5 minutes'
                   AND labels ? 'stack'
                   AND labels->>'stack' = $1
                 ORDER BY resource",
                &[&name],
            )
            .await
            .context("list stack containers")?;

        let container_names: Vec<String> =
            container_rows.into_iter().map(|r| r.get(0)).collect();
        let backend_running = !container_names.is_empty();

        out.push(StackSummary {
            name,
            vercel_state,
            backend_running,
            container_names,
        });
    }

    Ok(out)
}

/// Detalhe de uma stack: último deploy Vercel + snapshots de containers + health endpoint.
///
/// Health endpoint match é best-effort (`endpoint ILIKE '%name%'`). Pode não casar
/// se o nome da stack não aparecer na URL — nesse caso `endpoint_health` fica `None`.
pub async fn stack_detail(pool: &Pool, name: &str) -> Result<StackDetail> {
    let client = pool.get().await?;

    // 1) Último deploy Vercel
    let vercel = client
        .query_opt(
            "SELECT project_name, state, url, prod_url, branch, commit_msg, author,
                    created_at, ready_at, build_ms
             FROM vercel_deployments
             WHERE project_name = $1
             ORDER BY ts DESC LIMIT 1",
            &[&name],
        )
        .await
        .context("fetch latest vercel deploy")?
        .map(|r| VercelDeploymentRow {
            project_name: r.get(0),
            state: r.get(1),
            url: r.get(2),
            prod_url: r.get(3),
            branch: r.get(4),
            commit_msg: r.get(5),
            author: r.get(6),
            created_at: r.get(7),
            ready_at: r.get(8),
            build_ms: r.get(9),
        });

    // 2) Containers da stack (snapshot último 1min) — formato igual list_containers
    //    mas filtrado por labels->>'stack' = $1.
    let container_rows = client
        .query(
            r#"
            WITH latest AS (
              SELECT DISTINCT ON (resource, metric)
                resource, metric, value, ts
              FROM metrics
              WHERE source = 'container'
                AND metric IN ('cpu_pct', 'mem_pct', 'mem_used_bytes', 'mem_limit_bytes')
                AND ts > now() - interval '1 minute'
                AND labels ? 'stack'
                AND labels->>'stack' = $1
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
            &[&name],
        )
        .await
        .context("stack containers snapshot")?;

    let containers: Vec<ContainerInfo> = container_rows
        .into_iter()
        .map(|r| ContainerInfo {
            name: r.get(0),
            last_cpu_pct: r.get(1),
            last_mem_pct: r.get(2),
            last_seen: r.get(3),
            last_mem_used_bytes: r.get(4),
            last_mem_limit_bytes: r.get(5),
        })
        .collect();

    // 3) Health endpoint best-effort (endpoint ILIKE '%name%')
    let endpoint_match: Option<String> = client
        .query_opt(
            "SELECT DISTINCT endpoint FROM health_checks
             WHERE endpoint ILIKE '%' || $1 || '%'
             LIMIT 1",
            &[&name],
        )
        .await
        .context("match health endpoint")?
        .map(|r| r.get::<_, String>(0));

    let endpoint_health = match endpoint_match {
        Some(ep) => Some(fetch_health_summary(pool, &ep).await?),
        None => None,
    };

    Ok(StackDetail {
        name: name.to_string(),
        vercel,
        containers,
        endpoint_health,
    })
}
