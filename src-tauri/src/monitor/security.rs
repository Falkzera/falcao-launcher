//! Queries SELECT pra tabela `vulnerabilities` (Sprint B1 — Snyk-like).
//!
//! Tabela única heterogênea com kind discriminator (deps|image|advisory).
//! Filtragem por severidade + kind no SQL (mais barato que client-side).

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use deadpool_postgres::Pool;
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize)]
pub struct VulnerabilityRow {
    pub kind: String,
    pub severity: String,
    pub cve_id: Option<String>,
    pub ghsa_id: Option<String>,
    pub source_id: String,
    pub package_name: Option<String>,
    pub package_version: Option<String>,
    pub fix_version: Option<String>,
    pub title: Option<String>,
    pub url: Option<String>,
    pub state: String,
    pub last_seen: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct VulnSummary {
    pub critical: i64,
    pub high: i64,
    pub medium: i64,
    pub low: i64,
    pub last_scan: Option<DateTime<Utc>>,
}

/// Lista vulnerabilidades open com filtros.
/// Retorna apenas a observação MAIS RECENTE de cada (kind, source_id, cve_id) —
/// evita duplicados quando scans repetidos persistem o mesmo CVE.
pub async fn list_vulnerabilities(
    pool: &Pool,
    severities: &[String],
    kinds: &[String],
) -> Result<Vec<VulnerabilityRow>> {
    let client = pool.get().await?;

    let valid_severities = ["critical", "high", "medium", "low", "unknown"];
    let valid_kinds = ["deps", "image", "advisory"];

    let sev_filter: Vec<String> = severities
        .iter()
        .filter(|s| valid_severities.contains(&s.as_str()))
        .cloned()
        .collect();
    let kind_filter: Vec<String> = kinds
        .iter()
        .filter(|k| valid_kinds.contains(&k.as_str()))
        .cloned()
        .collect();

    if sev_filter.is_empty() || kind_filter.is_empty() {
        return Ok(Vec::new());
    }

    let rows = client
        .query(
            r#"
            SELECT DISTINCT ON (kind, source_id, COALESCE(cve_id, ghsa_id, package_name))
              kind, severity, cve_id, ghsa_id, source_id, package_name,
              package_version, fix_version, title, url, state, ts
            FROM vulnerabilities
            WHERE state = 'open'
              AND ts > now() - interval '7 days'
              AND severity = ANY($1)
              AND kind = ANY($2)
            ORDER BY kind, source_id, COALESCE(cve_id, ghsa_id, package_name), ts DESC
            "#,
            &[&sev_filter, &kind_filter],
        )
        .await
        .context("list vulnerabilities")?;

    Ok(rows
        .into_iter()
        .map(|r| VulnerabilityRow {
            kind: r.get(0),
            severity: r.get(1),
            cve_id: r.get(2),
            ghsa_id: r.get(3),
            source_id: r.get(4),
            package_name: r.get(5),
            package_version: r.get(6),
            fix_version: r.get(7),
            title: r.get(8),
            url: r.get(9),
            state: r.get(10),
            last_seen: r.get(11),
        })
        .collect())
}

pub async fn vuln_summary(pool: &Pool) -> Result<VulnSummary> {
    let client = pool.get().await?;

    let row = client
        .query_one(
            r#"
            WITH latest AS (
              SELECT DISTINCT ON (kind, source_id, COALESCE(cve_id, ghsa_id, package_name))
                severity, ts
              FROM vulnerabilities
              WHERE state = 'open' AND ts > now() - interval '7 days'
              ORDER BY kind, source_id, COALESCE(cve_id, ghsa_id, package_name), ts DESC
            )
            SELECT
              COUNT(*) FILTER (WHERE severity = 'critical') AS critical,
              COUNT(*) FILTER (WHERE severity = 'high')     AS high,
              COUNT(*) FILTER (WHERE severity = 'medium')   AS medium,
              COUNT(*) FILTER (WHERE severity = 'low')      AS low,
              MAX(ts) AS last_scan
            FROM latest
            "#,
            &[],
        )
        .await
        .context("vuln summary")?;

    Ok(VulnSummary {
        critical: row.get(0),
        high: row.get(1),
        medium: row.get(2),
        low: row.get(3),
        last_scan: row.get(4),
    })
}

/// Retorna a lista de "tokens" trackeados pelo monitor (Sprint B1.5).
///
/// Tokens vêm de 3 fontes na VM/produção:
///   - Vercel project names (frontend trackeado)
///   - Container resources rodando nos últimos 7 dias
///   - Stack labels de containers (`monitor.stack=...`)
///
/// O frontend usa esses tokens em substring match (case-insensitive)
/// contra `vuln.source_id` pra esconder repos antigos não-trackeados.
/// Imagens Docker (`kind=image`) são automaticamente trackeadas
/// (Trivy só escaneia imagens em uso na VM).
pub async fn list_tracked_tokens(pool: &Pool) -> Result<Vec<String>> {
    let client = pool.get().await?;

    let rows = client
        .query(
            r#"
            SELECT DISTINCT project_name FROM vercel_deployments
              WHERE project_name IS NOT NULL AND project_name <> ''
            UNION
            SELECT DISTINCT resource FROM metrics
              WHERE source = 'container'
                AND ts > now() - interval '7 days'
                AND resource IS NOT NULL
            UNION
            SELECT DISTINCT (labels->>'stack') FROM metrics
              WHERE source = 'container'
                AND ts > now() - interval '7 days'
                AND labels ? 'stack'
                AND (labels->>'stack') <> ''
            "#,
            &[],
        )
        .await
        .context("list tracked tokens")?;

    Ok(rows.into_iter().map(|r| r.get::<_, String>(0)).collect())
}

pub async fn vuln_count_by_repo(pool: &Pool) -> Result<HashMap<String, i64>> {
    let client = pool.get().await?;

    let rows = client
        .query(
            r#"
            WITH latest AS (
              SELECT DISTINCT ON (kind, source_id, COALESCE(cve_id, ghsa_id, package_name))
                kind, source_id, severity
              FROM vulnerabilities
              WHERE state = 'open' AND ts > now() - interval '7 days'
              ORDER BY kind, source_id, COALESCE(cve_id, ghsa_id, package_name), ts DESC
            )
            SELECT source_id, COUNT(*)
            FROM latest
            WHERE kind = 'deps' AND severity IN ('critical', 'high')
            GROUP BY source_id
            "#,
            &[],
        )
        .await
        .context("vuln count by repo")?;

    let mut out = HashMap::with_capacity(rows.len());
    for r in rows {
        out.insert(r.get::<_, String>(0), r.get::<_, i64>(1));
    }
    Ok(out)
}
